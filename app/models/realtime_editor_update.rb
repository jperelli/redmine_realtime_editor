# One Yjs update (base64) in the log of a document.
class RealtimeEditorUpdate < ActiveRecord::Base
  belongs_to :document, class_name: 'RealtimeEditorDocument', inverse_of: :updates

  validates :seq, presence: true
  validates :data, presence: true

  def as_json(_options = nil)
    { 'seq' => seq, 'data' => data }
  end
end
