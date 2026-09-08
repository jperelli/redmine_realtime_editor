require "#{File.dirname(__FILE__)}/../test_helper"

class RealtimeEditorDocumentTest < ActiveSupport::TestCase
  fixtures :users

  def setup
    @doc = RealtimeEditorDocument.for_key('issue:1:description')
  end

  def test_for_key_is_idempotent
    assert_equal @doc, RealtimeEditorDocument.for_key('issue:1:description')
    assert_equal 1, @doc.epoch
    assert_equal 0, @doc.last_seq
  end

  def test_append_allocates_consecutive_sequence_numbers
    first = @doc.append!('AAAA', 2)
    second = @doc.append!('BBBB', 3)
    assert_equal [1, 2], [first.seq, second.seq]
    assert_equal 2, @doc.reload.last_seq
    assert_equal %w[AAAA BBBB], @doc.updates_since(0).map(&:data)
    assert_equal %w[BBBB], @doc.updates_since(1).map(&:data)
  end

  def test_append_retries_when_another_writer_took_the_sequence
    other = RealtimeEditorDocument.find(@doc.id)
    other.append!('AAAA', 2)
    assert_equal 2, @doc.append!('BBBB', 2).seq
  end

  def test_seed_only_once
    assert @doc.seed!('SEED', 2)
    assert_not @doc.seed!('SEED2', 3)
    assert_equal ['SEED'], @doc.updates_since(0).map(&:data)
    assert_equal 1, @doc.reload.last_seq
  end

  def test_compact_replaces_old_updates_with_one_snapshot
    5.times { |i| @doc.append!("U#{i}", 2) }
    assert @doc.compact!('SNAP', 3, 2)
    assert_equal %w[SNAP U3 U4], @doc.updates_since(0).map(&:data)
    assert_equal [3, 4, 5], @doc.updates_since(0).map(&:seq)
    assert_equal 5, @doc.reload.last_seq
  end

  def test_compact_ignores_nonsense
    assert_not @doc.compact!('SNAP', 0, 2)
  end

  def test_reset_bumps_epoch_and_clears_everything
    @doc.append!('AAAA', 2)
    @doc.update_columns(synced_version: 4)
    @doc.reset!
    @doc.reload
    assert_equal 2, @doc.epoch
    assert_equal 0, @doc.last_seq
    assert_nil @doc.synced_version
    assert_equal 0, @doc.updates.count
  end

  def test_presence_upsert_and_timeout
    @doc.touch_presence!('tab-a', 2, typing: true)
    @doc.touch_presence!('tab-a', 2, typing: false)
    @doc.touch_presence!('tab-b', 3, typing: false)
    assert_equal 2, @doc.presences.count
    assert_equal [false, false], @doc.active_presences.map(&:typing)
    assert_equal 'John Smith', @doc.active_presences.first.as_json['name']

    @doc.presences.where(client_id: 'tab-b').update_all(updated_at: 2.minutes.ago)
    assert_equal ['tab-a'], @doc.active_presences.map(&:client_id)
  end

  def test_cleanup_removes_stale_documents_only
    @doc.append!('AAAA', 2)
    @doc.touch_presence!('tab-a', 2, typing: false)
    fresh = RealtimeEditorDocument.for_key('issue:2:description')
    @doc.update_columns(updated_at: 2.hours.ago)

    assert_equal 1, RealtimeEditorDocument.cleanup!(30.minutes)
    assert_nil RealtimeEditorDocument.find_by(id: @doc.id)
    assert_equal 0, RealtimeEditorUpdate.where(document_id: @doc.id).count
    assert_equal 0, RealtimeEditorPresence.where(document_id: @doc.id).count
    assert RealtimeEditorDocument.exists?(fresh.id)
  end

  def test_stale
    assert_not @doc.stale?(30.minutes)
    @doc.update_columns(updated_at: 31.minutes.ago)
    assert @doc.stale?(30.minutes)
  end
end
