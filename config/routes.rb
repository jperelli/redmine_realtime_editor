Rails.application.routes.draw do
  # One endpoint does everything a collaborating browser needs: join a
  # document, push local Yjs updates, pull the updates of the others, report
  # presence and compact the log. A second one drops the presence row when the
  # editor goes away (sent as a keepalive request from pagehide).
  post 'realtime_editor/sync',  to: 'realtime_editor#sync',  as: 'realtime_editor_sync'
  post 'realtime_editor/leave', to: 'realtime_editor#leave', as: 'realtime_editor_leave'
end
