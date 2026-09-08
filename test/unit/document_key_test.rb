require "#{File.dirname(__FILE__)}/../test_helper"

class DocumentKeyTest < ActiveSupport::TestCase
  fixtures :projects, :users, :email_addresses, :roles, :members, :member_roles,
           :trackers, :projects_trackers, :enabled_modules, :issue_statuses,
           :enumerations, :issues, :journals, :journal_details,
           :wikis, :wiki_pages, :wiki_contents, :wiki_content_versions

  def setup
    Setting.plugin_redmine_realtime_editor = {}
    @manager = User.find(2)
    @anonymous = User.anonymous
  end

  def resolve(key, user = @manager)
    RedmineRealtimeEditor::DocumentKey.resolve(key, user)
  end

  def test_issue_description
    target = resolve('issue:1:description')
    assert_equal 'issue_description', target.kind
    assert_equal Issue.find(1).description, target.saved_text
    assert_equal Issue.find(1).lock_version, target.version
    assert_equal Issue.find(1), target.record
  end

  def test_issue_notes_have_no_saved_text
    target = resolve('issue:1:notes')
    assert_equal 'issue_notes', target.kind
    assert_nil target.saved_text
    assert target.presence_only, 'private by default'

    Setting.plugin_redmine_realtime_editor = { 'notes_mode' => 'shared' }
    assert_not resolve('issue:1:notes').presence_only
    assert_not resolve('issue:1:description').presence_only
  end

  def test_issue_attributes
    target = resolve('issue:1:attributes')
    assert_equal 'issue_attributes', target.kind
    assert_nil target.saved_text, 'the values live in the form, the map only carries changes'
    assert_equal Issue.find(1).lock_version, target.version
    assert_equal Issue.find(1), target.record
    assert_not target.presence_only
  end

  def test_issue_requires_edit_permission
    Role.anonymous.remove_permission!(:add_issue_notes)
    assert_nil resolve('issue:1:description', @anonymous)
    assert_nil resolve('issue:1:attributes', @anonymous)
    assert_nil resolve('issue:1:notes', @anonymous)
    Role.anonymous.add_permission!(:add_issue_notes)
    assert_not_nil resolve('issue:1:notes', User.anonymous)
    assert_nil resolve('issue:1:description', User.anonymous)
    assert_nil resolve('issue:1:attributes', User.anonymous)
  end

  def test_invisible_or_missing_issue
    assert_nil resolve('issue:999999:description')
    assert_nil resolve('issue:4:description', User.find(7)) # private project
  end

  def test_journal_notes
    assert_nil resolve('journal:1:notes'), 'manager may not edit notes of others without edit_issue_notes'
    Role.find(1).add_permission!(:edit_issue_notes)
    target = resolve('journal:1:notes', User.find(2))
    assert_equal 'journal_notes', target.kind
    assert_equal Journal.find(1).notes, target.saved_text
    assert_nil resolve('journal:1:notes', @anonymous)
    assert_nil resolve('journal:1:description')
  end

  def test_wiki_page
    target = resolve('wiki:ecookbook:CookBook_documentation')
    assert_equal 'wiki', target.kind
    assert_equal WikiPage.find(1).content.text, target.saved_text
    assert_equal WikiPage.find(1).content.version, target.version
    assert_nil resolve('wiki:ecookbook:CookBook_documentation', @anonymous)
  end

  def test_wiki_new_page_and_section
    target = resolve('wiki:ecookbook:Brand_new_page')
    assert_equal '', target.saved_text
    assert_nil target.record
    assert_nil target.version

    section = resolve('wiki:ecookbook:Page_with_sections/2')
    assert_equal 'wiki', section.kind
    assert_includes WikiPage.find_by(title: 'Page_with_sections').content.text, section.saved_text.strip
  end

  def test_disabled_targets
    Setting.plugin_redmine_realtime_editor = { 'enable_issue_description' => '0', 'enable_wiki' => '0',
                                               'enable_issue_attributes' => '0' }
    assert_nil resolve('issue:1:description')
    assert_nil resolve('issue:1:attributes')
    assert_not_nil resolve('issue:1:notes')
    assert_nil resolve('wiki:ecookbook:CookBook_documentation')
  end

  def test_garbage_keys
    assert_nil resolve('')
    assert_nil resolve('nonsense')
    assert_nil resolve('issue:1')
    assert_nil resolve('issue:abc:description')
    assert_nil resolve('wiki:ecookbook')
    assert_nil resolve("issue:1:#{'x' * 300}")
  end
end
