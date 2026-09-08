# Transport for the collaborative editor. Browsers POST here periodically
# (plain or long polling) instead of holding a websocket, so the plugin works
# behind any reverse proxy and needs no extra process.
class RealtimeEditorController < ApplicationController
  before_action :require_login
  before_action :find_target
  before_action :check_payload_size, only: :sync

  # Params:
  #   key        document key (see RedmineRealtimeEditor::DocumentKey)
  #   client_id  random id of the browser tab
  #   epoch      epoch the client is on (omitted on the first call)
  #   since      last seq the client has applied
  #   update     base64 Yjs update to append (optional)
  #   seed       base64 initial state, stored only if the log is empty (optional)
  #   snapshot   base64 merged state replacing the log up to snapshot_upto (optional)
  #   typing     "1" while the user is typing (presence)
  #   cursor     caret/selection as JSON of Yjs relative positions (presence, optional)
  #   presence   "1" to (re)write the presence row
  #   wait       "1" to hold the request until something changes (long polling)
  def sync
    doc = RealtimeEditorDocument.for_key(@target.key)
    maybe_cleanup
    doc.reset! if doc.last_seq.positive? && doc.stale? && doc.active_presences.none?

    epoch_changed = params[:epoch].present? && params[:epoch].to_i != doc.epoch
    since = epoch_changed ? 0 : params[:since].to_i
    joining = params[:epoch].blank? || epoch_changed

    payload = { 'epoch' => doc.epoch }
    payload['seeded'] = doc.seed!(params[:seed], User.current.id) if params[:seed].present? && !epoch_changed
    doc.append!(params[:update], User.current.id) if params[:update].present? && !epoch_changed
    if params[:snapshot].present? && !epoch_changed
      payload['compacted'] = doc.compact!(params[:snapshot], params[:snapshot_upto].to_i, User.current.id)
    end
    if presence_wanted?
      doc.touch_presence!(client_id, User.current.id, typing: params[:typing].to_s == '1', cursor: cursor_param)
    end

    updates = wait_for_updates(doc, since)
    payload['updates'] = updates.map(&:as_json)
    payload['last_seq'] = updates.last&.seq || since
    payload['epoch_changed'] = true if epoch_changed
    payload['saved_text'] = @target.saved_text if joining
    payload['synced_version'] = doc.synced_version
    payload['synced_from_version'] = doc.synced_from_version
    payload['presences'] = doc.active_presences.where.not(client_id: client_id).map(&:as_json)
    payload['compact_suggested'] = true if doc.updates.count > RedmineRealtimeEditor::Settings.compact_after
    render json: payload
  rescue RealtimeEditorDocument::Conflict => e
    render json: { 'error' => e.message }, status: :conflict
  end

  def leave
    doc = RealtimeEditorDocument.find_by(doc_key: @target.key)
    doc.presences.where(client_id: client_id).delete_all if doc
    head :no_content
  end

  private

  def find_target
    @target = RedmineRealtimeEditor::DocumentKey.resolve(params[:key], User.current)
    return if @target && client_id.present?

    render json: { 'error' => 'forbidden' }, status: :forbidden
  end

  def client_id
    params[:client_id].to_s[0, 64]
  end

  def cursor_param
    cursor = params[:cursor].to_s
    return nil if cursor.empty? || cursor.length > RealtimeEditorPresence::MAX_CURSOR_LENGTH

    cursor
  end

  def check_payload_size
    max = RedmineRealtimeEditor::Settings::MAX_UPDATE_BYTES
    return if %i[update seed snapshot].all? { |p| params[p].to_s.bytesize <= max }

    render json: { 'error' => 'payload too large' }, status: 413
  end

  def presence_wanted?
    params[:presence].to_s == '1' || params[:epoch].blank?
  end

  # Long polling: keeps the request open (checking the log a few times a second)
  # until new updates arrive or the configured hold expires. Off by default.
  def wait_for_updates(doc, since)
    updates = doc.updates_since(since).to_a
    hold = RedmineRealtimeEditor::Settings.long_poll_seconds
    return updates unless params[:wait].to_s == '1' && hold.positive? && updates.empty?

    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + hold
    while updates.empty? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
      sleep 0.25
      updates = doc.updates_since(since).to_a
    end
    updates
  end

  # Expired drafts are garbage collected from ordinary traffic, no cron needed.
  def maybe_cleanup
    return unless rand(50).zero?

    RealtimeEditorDocument.cleanup!
  end
end
