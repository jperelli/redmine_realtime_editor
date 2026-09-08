require "#{File.dirname(__FILE__)}/../test_helper"

class RealtimeEditorControllerTest < ActionController::TestCase
  fixtures :projects, :users, :email_addresses, :roles, :members, :member_roles,
           :trackers, :projects_trackers, :enabled_modules, :issue_statuses,
           :enumerations, :issues, :journals, :journal_details

  KEY = 'issue:1:description'.freeze

  def setup
    Setting.plugin_redmine_realtime_editor = {}
    @request.session[:user_id] = 2
  end

  def sync(params = {})
    post :sync, params: { key: KEY, client_id: 'tab-a' }.merge(params)
    assert_response :success
    JSON.parse(@response.body)
  end

  def test_requires_login
    @request.session[:user_id] = nil
    post :sync, params: { key: KEY, client_id: 'tab-a', format: 'json' }
    assert_includes [401, 403], response.status
    assert_equal 0, RealtimeEditorDocument.count
  end

  def test_forbidden_without_permission
    @request.session[:user_id] = 7 # not a member of the private project of issue #4
    post :sync, params: { key: 'issue:4:description', client_id: 'tab-a' }
    assert_response :forbidden
    assert_equal 0, RealtimeEditorDocument.count
  end

  def test_forbidden_without_client_id
    post :sync, params: { key: KEY }
    assert_response :forbidden
  end

  def test_joining_returns_saved_text_and_empty_log
    json = sync
    assert_equal 1, json['epoch']
    assert_equal Issue.find(1).description, json['saved_text']
    assert_equal [], json['updates']
    assert_equal 0, json['last_seq']
    assert_equal [], json['presences']
    assert_nil json['synced_version']
  end

  def test_seed_then_exchange_updates_between_two_clients
    sync
    json = sync(epoch: 1, since: 0, seed: 'U0VFRA==')
    assert_equal true, json['seeded']
    assert_equal 1, json['last_seq']
    assert_equal ['U0VFRA=='], json['updates'].pluck('data')
    assert_nil json['saved_text']

    b = sync(client_id: 'tab-b')
    assert_equal %w[U0VFRA==], b['updates'].pluck('data')
    assert_equal 1, b['last_seq']
    assert_equal ['tab-a'], b['presences'].pluck('client_id')
    assert_equal 'John Smith', b['presences'].first['name']

    b = sync(client_id: 'tab-b', epoch: 1, since: 1, update: 'QQ==', presence: '1', typing: '1')
    assert_equal 2, b['last_seq']
    assert_equal [2], b['updates'].pluck('seq')

    a = sync(epoch: 1, since: 1, presence: '1')
    assert_equal ['QQ=='], a['updates'].pluck('data')
    assert_equal [true], a['presences'].pluck('typing')
    assert_equal [], sync(epoch: 1, since: 2)['updates']
  end

  def test_cursor_is_relayed_to_the_other_clients_as_is
    sync
    cursor = '{"anchor":{"type":null,"tname":"text","item":{"client":1,"clock":3},"assoc":0}}'
    sync(epoch: 1, since: 0, presence: '1', cursor: cursor)

    b = sync(client_id: 'tab-b')
    assert_equal [cursor], b['presences'].pluck('cursor')

    sync(epoch: 1, since: 0, presence: '1')
    assert_equal [nil], sync(client_id: 'tab-b', epoch: 1, since: 0, presence: '1')['presences'].pluck('cursor')

    sync(epoch: 1, since: 0, presence: '1', cursor: 'x' * (RealtimeEditorPresence::MAX_CURSOR_LENGTH + 1))
    assert_equal [nil], sync(client_id: 'tab-b', epoch: 1, since: 0, presence: '1')['presences'].pluck('cursor')
  end

  def test_second_seed_is_rejected_but_log_is_returned
    sync
    sync(epoch: 1, since: 0, seed: 'QQ==')
    json = sync(client_id: 'tab-b', epoch: 1, since: 0, seed: 'Qg==')
    assert_equal false, json['seeded']
    assert_equal ['QQ=='], json['updates'].pluck('data')
  end

  def test_epoch_change_replays_from_scratch
    sync
    sync(epoch: 1, since: 0, seed: 'QQ==')
    RealtimeEditorDocument.find_by(doc_key: KEY).reset!

    json = sync(epoch: 1, since: 1, update: 'Qg==')
    assert_equal 2, json['epoch']
    assert_equal true, json['epoch_changed']
    assert_equal Issue.find(1).description, json['saved_text']
    assert_equal [], json['updates'], 'update sent against the old epoch is dropped'
    assert_equal 0, json['last_seq']
  end

  def test_compaction
    Setting.plugin_redmine_realtime_editor = { 'compact_after' => '10' }
    sync
    12.times { |i| sync(epoch: 1, since: i, update: 'QQ==') }
    json = sync(epoch: 1, since: 12)
    assert_equal true, json['compact_suggested']

    json = sync(epoch: 1, since: 12, snapshot: 'U05BUA==', snapshot_upto: 12)
    assert_equal true, json['compacted']
    assert_nil json['compact_suggested']
    late = sync(client_id: 'tab-c')
    assert_equal ['U05BUA=='], late['updates'].pluck('data')
    assert_equal 12, late['last_seq']
  end

  def test_stale_draft_is_reset_when_nobody_is_around
    sync
    sync(epoch: 1, since: 0, seed: 'QQ==')
    doc = RealtimeEditorDocument.find_by(doc_key: KEY)
    doc.presences.delete_all
    doc.update_columns(updated_at: 2.hours.ago)

    json = sync(client_id: 'tab-b')
    assert_equal 2, json['epoch']
    assert_equal [], json['updates']
  end

  def test_payload_too_large
    sync
    post :sync, params: { key: KEY, client_id: 'tab-a', epoch: 1, since: 0,
                          update: 'A' * (RedmineRealtimeEditor::Settings::MAX_UPDATE_BYTES + 1) }
    assert_response 413
  end

  def test_leave_removes_presence
    sync
    assert_equal 1, RealtimeEditorPresence.count
    post :leave, params: { key: KEY, client_id: 'tab-a' }
    assert_response :no_content
    assert_equal 0, RealtimeEditorPresence.count
  end

  def test_long_poll_returns_when_nothing_arrives
    Setting.plugin_redmine_realtime_editor = { 'long_poll_seconds' => '1' }
    sync
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    json = sync(epoch: 1, since: 0, wait: '1')
    elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
    assert_equal [], json['updates']
    assert_operator elapsed, :>=, 0.9
    assert_operator elapsed, :<, 3
  end

  def test_long_poll_is_disabled_by_default
    sync
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    sync(epoch: 1, since: 0, wait: '1')
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 0.5
  end
end
