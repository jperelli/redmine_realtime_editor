class CreateRealtimeEditorTables < ActiveRecord::Migration[6.1]
  def change
    # One row per live document (an issue description, a notes field, a wiki
    # page). Rows are transient: they are deleted once nobody has touched the
    # document for the configured draft lifetime.
    create_table :realtime_editor_documents do |t|
      t.string :doc_key, null: false, limit: 255
      # Bumped when the document is reset; clients holding an older epoch rejoin.
      t.integer :epoch, null: false, default: 1
      # Sequence number of the newest update, allocated atomically in Document#append!.
      t.integer :last_seq, null: false, default: 0
      # Record version (issue lock_version / wiki content version) after the
      # last save made from a collaborative form; other editors adopt it so
      # their own save does not trip Redmine's stale-object check.
      t.integer :synced_version
      # ...and the version that save started from: the hint is only good for
      # editors whose form was rendered at exactly that version.
      t.integer :synced_from_version
      # Record version the draft was made on top of; when the record moves on
      # without a collaborative save the draft is stale and is dropped.
      t.integer :record_version
      # User whose save caused the last reset (nil for a lifetime reset), so
      # the other editors can be told who posted the text.
      t.integer :reset_by_id
      t.timestamps null: false
    end
    add_index :realtime_editor_documents, :doc_key, unique: true
    add_index :realtime_editor_documents, :updated_at

    # Append-only log of Yjs updates (base64), replayed by joining clients.
    create_table :realtime_editor_updates do |t|
      t.integer :document_id, null: false
      t.integer :seq, null: false
      t.text :data, null: false, limit: 16_777_215
      t.integer :user_id
      t.datetime :created_at, null: false
    end
    add_index :realtime_editor_updates, %i[document_id seq], unique: true

    # Who has the document open (one row per browser tab).
    create_table :realtime_editor_presences do |t|
      t.integer :document_id, null: false
      t.string :client_id, null: false, limit: 64
      t.integer :user_id, null: false
      t.boolean :typing, null: false, default: false
      # Caret/selection as Yjs relative positions (JSON), so it stays attached
      # to the right character while the text changes around it.
      t.string :cursor, limit: 1000
      t.datetime :updated_at, null: false
    end
    add_index :realtime_editor_presences, %i[document_id client_id], unique: true
  end
end
