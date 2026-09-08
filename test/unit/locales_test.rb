require "#{File.dirname(__FILE__)}/../test_helper"

# Every locale file must define exactly the keys of the English one.
class RealtimeEditorLocalesTest < ActiveSupport::TestCase
  LOCALES_DIR = File.expand_path('../../config/locales', __dir__)

  def flatten(hash, prefix = nil)
    hash.flat_map do |key, value|
      name = [prefix, key].compact.join('.')
      value.is_a?(Hash) ? flatten(value, name) : [name]
    end
  end

  def test_locales_have_the_same_keys_as_english
    files = Dir[File.join(LOCALES_DIR, '*.yml')]
    assert files.size > 1, 'expected several locale files'

    en = YAML.load_file(File.join(LOCALES_DIR, 'en.yml'))['en']
    en_keys = flatten(en).sort
    files.each do |file|
      lang = File.basename(file, '.yml')
      data = YAML.load_file(file)
      assert_equal [lang], data.keys, "#{lang}.yml must have the single top level key #{lang}"
      assert_equal en_keys, flatten(data[lang]).sort, "#{lang}.yml keys differ from en.yml"
    end
  end

  def test_client_strings_exist
    RedmineRealtimeEditor::Hooks.client_config(Struct.new(:realtime_editor_sync_path, :realtime_editor_leave_path)
                                                     .new('/s', '/l'))[:i18n].each do |key, value|
      assert_not_includes value, 'translation missing', key
    end
  end
end
