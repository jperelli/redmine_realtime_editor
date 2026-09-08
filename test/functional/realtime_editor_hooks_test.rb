require "#{File.dirname(__FILE__)}/../test_helper"

class RealtimeEditorHooksTest < Redmine::IntegrationTest
  fixtures :projects, :users, :email_addresses, :roles, :members, :member_roles,
           :trackers, :projects_trackers, :enabled_modules, :issue_statuses,
           :enumerations, :issues, :journals, :journal_details, :workflows,
           :wikis, :wiki_pages, :wiki_contents, :wiki_content_versions

  def setup
    Setting.plugin_redmine_realtime_editor = {}
    log_user('jsmith', 'jsmith')
  end

  def test_scripts_are_included_on_collaborative_pages_only
    get '/issues/1'
    assert_response :success
    # Redmine 5 serves /plugin_assets/<plugin>/javascripts/x.js, Redmine 6+ /assets/plugin_assets/<plugin>/x-<digest>.js
    assert_select 'script[src*="plugin_assets/redmine_realtime_editor/"][src*="realtime_editor_yjs"]', 1
    assert_select 'script[src*="plugin_assets/redmine_realtime_editor/"][src*="realtime_editor"]', 2
    assert_select 'link[href*="plugin_assets/redmine_realtime_editor/"][href*="realtime_editor"]', 1
    assert_match(%r{RealtimeEditorConfig = \{.*"syncUrl":"/realtime_editor/sync"}, response.body)
    assert_match(/"targets":\["issue_description","issue_notes","journal_notes","wiki"\]/, response.body)

    get '/projects/ecookbook/wiki/CookBook_documentation/edit'
    assert_response :success
    assert_select 'script[src*="realtime_editor_yjs"]', 1

    get '/projects'
    assert_response :success
    assert_select 'script[src*="realtime_editor"]', 0
  end

  def test_scripts_are_not_included_for_anonymous_users
    reset!
    get '/issues/1'
    assert_response :success
    assert_select 'script[src*="realtime_editor"]', 0
  end

  def test_saving_a_collaborative_note_resets_the_notes_draft
    notes = RealtimeEditorDocument.for_key('issue:1:notes')
    notes.append!('QQ==', 2)
    other = RealtimeEditorDocument.for_key('issue:2:notes')
    other.append!('QQ==', 2)
    before = Issue.find(1).lock_version

    put '/issues/1', params: { issue: { notes: 'A co-written note', lock_version: before },
                               realtime_editor_docs: ['issue:1:notes'] }
    assert_redirected_to '/issues/1'
    assert_equal 2, notes.reload.epoch
    assert_equal 0, notes.updates.count
    assert_equal User.find(2), notes.reset_by
    assert_equal 1, other.reload.epoch, 'documents of other issues are untouched'

    after = Issue.find(1).lock_version
    assert_operator after, :>, before
    assert_equal [before, after], [notes.synced_from_version, notes.synced_version],
                 'a notes-only save is safe for everybody editing notes'
  end

  def test_saving_the_description_publishes_the_new_lock_version
    doc = RealtimeEditorDocument.for_key('issue:1:description')
    doc.append!('QQ==', 2)
    notes = RealtimeEditorDocument.for_key('issue:1:notes')
    before = Issue.find(1).lock_version

    put '/issues/1', params: { issue: { description: 'Merged text', lock_version: before },
                               realtime_editor_docs: ['issue:1:description'] }
    assert_redirected_to '/issues/1'
    after = Issue.find(1).lock_version
    assert_equal [before, after], [doc.reload.synced_from_version, doc.synced_version]
    assert_equal 1, doc.epoch, 'the draft is kept: the other editors already have this text'
    assert_nil notes.reload.synced_version, 'notes-only editors still carry the old description in their form'
  end

  def test_changing_other_attributes_withdraws_the_lock_version_hint
    doc = RealtimeEditorDocument.for_key('issue:1:description')
    doc.record_save!(0, Issue.find(1).lock_version)

    put '/issues/1', params: { issue: { subject: 'Renamed', lock_version: Issue.find(1).lock_version } }
    assert_redirected_to '/issues/1'
    assert_nil doc.reload.synced_version
    assert_nil doc.synced_from_version
  end

  def test_editing_a_journal_resets_its_draft
    Role.find(1).add_permission!(:edit_issue_notes)
    doc = RealtimeEditorDocument.for_key('journal:1:notes')
    doc.append!('QQ==', 2)

    put '/journals/1', params: { journal: { notes: 'Edited' }, realtime_editor_docs: ['journal:1:notes'] }
    assert_response :redirect
    assert_equal 2, doc.reload.epoch
    assert_equal 2, doc.reset_by_id
  end

  def test_client_config_carries_the_notes_mode_and_the_banner_strings
    get '/issues/1'
    assert_match(/"notesMode":"private"/, response.body)
    assert_match(/"posted_by":"%\{name\} posted this text as a comment\."/, response.body)

    Setting.plugin_redmine_realtime_editor = { 'notes_mode' => 'shared' }
    get '/issues/1'
    assert_match(/"notesMode":"shared"/, response.body)
  end

  def test_saving_a_wiki_page_publishes_the_new_version
    doc = RealtimeEditorDocument.for_key('wiki:ecookbook:CookBook_documentation')
    doc.append!('QQ==', 2)
    page = WikiPage.find(1)

    put '/projects/ecookbook/wiki/CookBook_documentation',
        params: { content: { text: 'New text', version: page.content.version },
                  realtime_editor_docs: ['wiki:ecookbook:CookBook_documentation'] }
    assert_redirected_to '/projects/ecookbook/wiki/CookBook_documentation'
    before = page.content.version
    assert_equal [before, before + 1], [doc.reload.synced_from_version, doc.synced_version]
    assert_equal before + 1, page.content.reload.version
  end

  def test_docs_of_unrelated_records_are_ignored
    doc = RealtimeEditorDocument.for_key('issue:2:notes')
    doc.append!('QQ==', 2)

    put '/issues/1', params: { issue: { notes: 'x', lock_version: Issue.find(1).lock_version },
                               realtime_editor_docs: ['issue:2:notes'] }
    assert_redirected_to '/issues/1'
    assert_equal 1, doc.reload.epoch
  end
end
