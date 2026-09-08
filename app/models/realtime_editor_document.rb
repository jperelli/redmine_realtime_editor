# A live document: the shared draft of one editable text field, identified by
# its key (see RedmineRealtimeEditor::DocumentKey). The server never interprets
# the Yjs updates it relays; it only guarantees that every client sees them in
# the same order (seq) and that a joining client can replay the whole log.
class RealtimeEditorDocument < ActiveRecord::Base
  has_many :updates, class_name: 'RealtimeEditorUpdate', foreign_key: :document_id,
                     inverse_of: :document, dependent: :delete_all
  has_many :presences, class_name: 'RealtimeEditorPresence', foreign_key: :document_id,
                       inverse_of: :document, dependent: :delete_all

  validates :doc_key, presence: true, length: { maximum: 255 }

  SEQ_RETRIES = 20

  class Conflict < StandardError; end

  def self.for_key(key)
    find_or_create_by!(doc_key: key)
  rescue ActiveRecord::RecordNotUnique
    find_by!(doc_key: key)
  end

  # Appends one update and returns it. The sequence number is allocated with a
  # compare-and-set on last_seq, so concurrent appends (several Puma workers,
  # several servers) never share a number and are committed in seq order.
  def append!(data, user_id)
    SEQ_RETRIES.times do
      current = self.class.where(id: id).pick(:last_seq)
      raise ActiveRecord::RecordNotFound if current.nil?

      result = transaction do
        claimed = self.class.where(id: id, last_seq: current)
                      .update_all(last_seq: current + 1, updated_at: Time.current)
        next nil unless claimed == 1

        updates.create!(seq: current + 1, data: data, user_id: user_id)
      end
      if result
        self.last_seq = current + 1
        return result
      end
    end
    raise Conflict, "could not allocate a sequence number for document #{doc_key}"
  end

  # Stores the initial content when the log is still empty. Two clients that
  # join an empty document at the same time both try to seed it; only the first
  # one wins, the other one gets false and replays the log instead.
  def seed!(data, user_id)
    transaction do
      claimed = self.class.where(id: id, last_seq: 0).update_all(last_seq: 1, updated_at: Time.current)
      if claimed == 1
        updates.create!(seq: 1, data: data, user_id: user_id)
        self.last_seq = 1
      end
      claimed == 1
    end
  end

  # Replaces every update up to +upto+ with one snapshot that a client
  # guarantees to contain all of them (Yjs merges are idempotent, so a snapshot
  # that also contains later updates is harmless).
  def compact!(data, upto, user_id)
    return false if upto <= 0

    transaction do
      updates.where(seq: ..upto).delete_all
      updates.create!(seq: upto, data: data, user_id: user_id)
    end
    true
  rescue ActiveRecord::RecordNotUnique
    false
  end

  # Drops the draft. Clients holding the old epoch notice on their next poll
  # and rejoin, starting again from the saved text.
  def reset!
    transaction do
      updates.delete_all
      update_columns(epoch: epoch + 1, last_seq: 0, synced_version: nil, synced_from_version: nil,
                     updated_at: Time.current)
    end
  end

  # Records that the underlying record went from version +from+ to +to+ through
  # a save whose only effect the other editors already have in their text.
  # +nil+ withdraws the hint (something else changed: let Redmine's conflict
  # page handle it).
  def record_save!(from, to)
    update_columns(synced_from_version: from, synced_version: to)
  end

  def updates_since(seq)
    updates.where(seq: (seq + 1)..).order(:seq)
  end

  def stale?(ttl = RedmineRealtimeEditor::Settings.draft_ttl)
    updated_at < ttl.ago
  end

  # Upserts the presence row of one browser tab. Also keeps the document alive
  # (updated_at) while somebody has it open.
  def touch_presence!(client_id, user_id, typing:)
    now = Time.current
    updated = presences.where(client_id: client_id).update_all(user_id: user_id, typing: typing, updated_at: now)
    presences.create!(client_id: client_id, user_id: user_id, typing: typing, updated_at: now) if updated.zero?
    self.class.where(id: id).update_all(updated_at: now)
  rescue ActiveRecord::RecordNotUnique
    presences.where(client_id: client_id).update_all(user_id: user_id, typing: typing, updated_at: now)
  end

  def active_presences
    presences.where(updated_at: RealtimeEditorPresence::TIMEOUT.ago..).includes(:user).order(:id)
  end

  # Removes documents nobody has touched for +ttl+ (called opportunistically).
  def self.cleanup!(ttl = RedmineRealtimeEditor::Settings.draft_ttl)
    ids = where(updated_at: ...ttl.ago).pluck(:id)
    return 0 if ids.empty?

    RealtimeEditorUpdate.where(document_id: ids).delete_all
    RealtimeEditorPresence.where(document_id: ids).delete_all
    where(id: ids).delete_all
  end
end
