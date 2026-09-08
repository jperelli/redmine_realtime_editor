require "#{File.dirname(__FILE__)}/../test_helper"

class RealtimeEditorSettingsTest < Redmine::IntegrationTest
  fixtures :users, :email_addresses, :roles

  def setup
    Setting.plugin_redmine_realtime_editor = {}
    log_user('admin', 'admin')
  end

  def test_settings_page_renders_and_saves
    get '/settings/plugin/redmine_realtime_editor'
    assert_response :success
    assert_select 'input[name="settings[enable_wiki]"][type=checkbox][checked]'
    assert_select 'input[name="settings[enable_issue_attributes]"][type=checkbox][checked]'
    assert_select 'input[name="settings[long_poll_seconds]"][value="0"]'
    assert_select 'select[name="settings[notes_mode]"] option[value=private][selected]'

    post '/settings/plugin/redmine_realtime_editor',
         params: { settings: { enable_wiki: '0', poll_active_ms: '500', long_poll_seconds: '99',
                               draft_ttl_minutes: '5', notes_mode: 'shared' } }
    assert_redirected_to '/settings/plugin/redmine_realtime_editor'

    settings = RedmineRealtimeEditor::Settings
    assert_not settings.enabled?(:wiki)
    assert settings.enabled?(:issue_notes)
    assert_equal 500, settings.poll_active_ms
    assert_equal settings::LONG_POLL_MAX_SECONDS, settings.long_poll_seconds, 'capped'
    assert_equal 5.minutes, settings.draft_ttl
    assert_equal %w[issue_description issue_attributes issue_notes journal_notes], settings.client_config[:targets]
    assert settings.notes_shared?
    assert_equal 'shared', settings.client_config[:notesMode]
  end

  def test_out_of_range_values_fall_back_to_defaults
    Setting.plugin_redmine_realtime_editor = { 'poll_active_ms' => '10', 'compact_after' => '-1', 'notes_mode' => 'x' }
    assert_equal 1000, RedmineRealtimeEditor::Settings.poll_active_ms
    assert_equal 200, RedmineRealtimeEditor::Settings.compact_after
    assert_equal 'private', RedmineRealtimeEditor::Settings.notes_mode
  end
end
