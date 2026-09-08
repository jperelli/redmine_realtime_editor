require 'redmine'

# Loaded here (not through autoloading) so the settings module is available to
# the registration below and the hook listener registers itself at boot.
require_relative 'lib/redmine_realtime_editor/settings'
require_relative 'lib/redmine_realtime_editor/document_key'
require_relative 'lib/redmine_realtime_editor/hooks'

Redmine::Plugin.register :redmine_realtime_editor do
  name 'Redmine Realtime Editor plugin'
  author 'Julian Perelli'
  description 'Collaborative real-time editing of issue descriptions, notes and wiki pages ' \
              'over plain HTTP polling: no websocket server or extra infrastructure needed'
  version '0.1.0'
  url 'https://github.com/jperelli/redmine_realtime_editor/'
  author_url 'https://jperelli.com.ar/'

  requires_redmine version_or_higher: '5.1.0'

  settings default: RedmineRealtimeEditor::Settings::DEFAULTS.dup,
           partial: 'settings/realtime_editor'
end
