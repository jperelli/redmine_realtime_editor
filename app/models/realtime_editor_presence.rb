# A browser tab that has a document open. Rows are refreshed by the client's
# polls and considered gone after TIMEOUT without news.
class RealtimeEditorPresence < ActiveRecord::Base
  TIMEOUT = 45.seconds

  belongs_to :document, class_name: 'RealtimeEditorDocument', inverse_of: :presences
  belongs_to :user

  def as_json(_options = nil)
    {
      'client_id' => client_id,
      'user_id' => user_id,
      'name' => user&.name.to_s,
      'typing' => typing,
      'updated_at' => updated_at.to_i
    }
  end
end
