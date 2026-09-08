module RedmineRealtimeEditor
  # Maps a document key sent by the browser to the Redmine record behind it and
  # decides whether the current user may collaborate on it. Keys are built by
  # the client from the form it is attached to:
  #
  #   issue:123:description        description of issue #123
  #   issue:123:attributes         every other field of the issue #123 edit form
  #   issue:123:notes              the "Notes" field on the issue #123 edit form
  #   journal:456:notes            inline editing of journal #456
  #   wiki:<project>:<Title>       wiki page (may not exist yet)
  #   wiki:<project>:<Title>/3     section 3 of a wiki page
  #
  # Access is decided with the same checks Redmine applies to the form itself,
  # so the plugin does not add permissions of its own.
  class DocumentKey
    # presence_only: the field is not shared, the document only tracks who is
    # writing in it (issue notes in private mode).
    Target = Struct.new(:key, :kind, :saved_text, :version, :record, :presence_only, keyword_init: true)

    MAX_LENGTH = 255

    # Returns a Target, or nil when the key is unknown, disabled or the user is
    # not allowed to edit the field.
    def self.resolve(key, user = User.current)
      new(key.to_s, user).resolve
    end

    def initialize(key, user)
      @key = key
      @user = user
    end

    def resolve
      return nil if @key.blank? || @key.length > MAX_LENGTH

      type, id, field = @key.split(':', 3)
      case type
      when 'issue'   then issue(id, field)
      when 'journal' then journal(id, field)
      when 'wiki'    then wiki(id, field)
      end
    end

    private

    def issue(id, field)
      issue = Issue.visible(@user).find_by(id: id.to_i)
      return nil unless issue

      case field
      when 'description'
        return nil unless Settings.enabled?(:issue_description) && issue.attributes_editable?(@user)

        Target.new(key: @key, kind: 'issue_description', saved_text: issue.description.to_s,
                   version: issue.lock_version, record: issue)
      when 'attributes'
        return nil unless Settings.enabled?(:issue_attributes) && issue.attributes_editable?(@user)

        # A map field => value kept only by the browsers; the form itself holds
        # the saved values.
        Target.new(key: @key, kind: 'issue_attributes', saved_text: nil, version: issue.lock_version, record: issue)
      when 'notes'
        return nil unless Settings.enabled?(:issue_notes) && issue.notes_addable?(@user)

        Target.new(key: @key, kind: 'issue_notes', saved_text: nil, version: nil, record: issue,
                   presence_only: !Settings.notes_shared?)
      end
    end

    def journal(id, field)
      return nil unless field == 'notes' && Settings.enabled?(:journal_notes)

      journal = Journal.find_by(id: id.to_i)
      return nil unless journal&.editable_by?(@user)

      Target.new(key: @key, kind: 'journal_notes', saved_text: journal.notes.to_s, version: nil, record: journal)
    end

    def wiki(project_identifier, title_and_section)
      return nil unless Settings.enabled?(:wiki) && title_and_section.present?

      project = Project.visible(@user).find_by(identifier: project_identifier.to_s)
      wiki = project&.wiki
      return nil unless wiki && @user.allowed_to?(:edit_wiki_pages, project)

      title, section = title_and_section.split('/', 2)
      page = wiki.find_page(title)
      return nil if page && !page.editable_by?(@user)
      return nil if page.nil? && title.length > 255

      content = page&.content
      text = content&.text.to_s
      text = section_text(text, section) if section
      Target.new(key: @key, kind: 'wiki', saved_text: text, version: content&.version, record: page)
    end

    def section_text(text, section)
      return text unless Redmine::WikiFormatting.supports_section_edit?

      Redmine::WikiFormatting.formatter.new(text).get_section(section.to_i).first.to_s
    end
  end
end
