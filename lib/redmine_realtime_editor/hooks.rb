require_relative 'settings'
require_relative 'document_key'

module RedmineRealtimeEditor
  class Hooks < Redmine::Hook::ViewListener
    # Pages that contain a collaborative textarea. Loading the scripts only
    # there keeps the rest of Redmine untouched.
    COLLABORATIVE_PAGES = {
      'issues' => %w[show edit update],
      'wiki' => %w[edit update new],
      'journals' => %w[edit update]
    }.freeze

    render_on :view_layouts_base_html_head, partial: 'realtime_editor/head'

    def self.collaborative_page?(controller)
      actions = COLLABORATIVE_PAGES[controller.controller_name]
      actions&.include?(controller.action_name) || false
    end

    CLIENT_STRINGS = %w[connecting live offline alone with_others reset typing draft_loaded
                        private_notes posted_by reload].freeze
    # Left in place for the browser to fill in.
    NAME_TOKEN = '%{name}'.freeze # rubocop:disable Style/FormatStringToken

    def self.client_config(view)
      Settings.client_config.merge(
        syncUrl: view.realtime_editor_sync_path,
        leaveUrl: view.realtime_editor_leave_path,
        userId: User.current.id,
        userName: User.current.name,
        i18n: CLIENT_STRINGS.to_h { |k| [k, ::I18n.t("label_realtime_editor_#{k}", name: NAME_TOKEN)] }
      )
    end

    # After a save made from a collaborative form the notes field starts over:
    # its text is now a journal.
    #
    # Every save of the issue also tells the other editors which lock_version
    # they may submit with. Their form still carries the old values of every
    # attribute they are not co-editing, so the hint is only safe when the save
    # changed nothing else: for description editors that means text only
    # (description and/or notes), for editors of the notes field alone that
    # means notes only. Anything else withdraws the hint and Redmine's regular
    # conflict page takes over.
    def controller_issues_edit_after_save(context)
      issue = context[:issue]
      journal = context[:journal]
      each_saved_document(context[:params], issue) do |doc, target|
        doc.reset!(User.current.id) if target.kind == 'issue_notes'
      end

      from = issue.lock_version_before_last_save || issue.lock_version
      hint("issue:#{issue.id}:description", from, issue.lock_version, text_only_change?(journal))
      hint("issue:#{issue.id}:notes", from, issue.lock_version, notes_only_change?(journal))
    end

    def controller_journals_edit_post(context)
      each_saved_document(context[:params], context[:journal]) do |doc, target|
        doc.reset!(User.current.id) if target.kind == 'journal_notes'
      end
    end

    # Wiki conflicts are about the text only, and every editor already has the
    # merged text, so their form may submit the version this save produced.
    def controller_wiki_edit_after_save(context)
      page = context[:page]
      content = page.content
      each_saved_document(context[:params], page) do |doc, target|
        next unless target.kind == 'wiki'

        doc.record_save!(content.version_before_last_save || (content.version - 1), content.version)
      end
    end

    SAFE_DETAILS = %w[attachment relation].freeze

    private

    def hint(key, from, to, safe)
      doc = RealtimeEditorDocument.find_by(doc_key: key)
      return unless doc

      safe ? doc.record_save!(from, to) : doc.record_save!(nil, nil)
    end

    def text_only_change?(journal)
      return true if journal.nil?

      journal.details.all? do |detail|
        SAFE_DETAILS.include?(detail.property) || (detail.property == 'attr' && detail.prop_key == 'description')
      end
    end

    def notes_only_change?(journal)
      return true if journal.nil?

      journal.details.all? { |detail| SAFE_DETAILS.include?(detail.property) }
    end

    # Yields the live documents named by the form (realtime_editor_docs[]) that
    # really belong to the saved record.
    def each_saved_document(params, record)
      keys = Array(params && params[:realtime_editor_docs]).map(&:to_s).first(10)
      keys.each do |key|
        target = DocumentKey.resolve(key, User.current)
        next unless target && target.record == record

        doc = RealtimeEditorDocument.find_by(doc_key: key)
        yield doc, target if doc
      end
    end
  end
end
