module RedmineRealtimeEditor
  # Typed access to the plugin settings (Administration > Plugins > Configure).
  module Settings
    DEFAULTS = {
      'enable_issue_description' => '1',
      'enable_issue_notes' => '1',
      'enable_journal_notes' => '1',
      'enable_wiki' => '1',
      # 'shared': everybody on the issue co-writes one comment, posted by
      # whoever submits. 'private': each user writes their own comment; the
      # others only see that they are writing.
      'notes_mode' => 'private',
      # Browser poll period while other people are on the document / while
      # alone / while the tab is in the background.
      'poll_active_ms' => '1000',
      'poll_idle_ms' => '3000',
      'poll_hidden_ms' => '20000',
      # Seconds the server keeps a poll request open waiting for changes.
      # 0 = plain polling. Each waiting request occupies an application server
      # thread, so this is off by default (Puma ships with 5 threads).
      'long_poll_seconds' => '0',
      # Documents nobody has touched for this long are discarded; the next
      # editor starts again from the saved text.
      'draft_ttl_minutes' => '30',
      # Log length after which a client is asked to post a merged snapshot.
      'compact_after' => '200'
    }.freeze

    NOTES_MODES = %w[shared private].freeze
    LONG_POLL_MAX_SECONDS = 25
    MAX_UPDATE_BYTES = 4.megabytes

    class << self
      def all
        DEFAULTS.merge((Setting.plugin_redmine_realtime_editor || {}).to_h.stringify_keys)
      end

      def enabled?(kind)
        all["enable_#{kind}"].to_s == '1'
      end

      def notes_mode
        mode = all['notes_mode'].to_s
        NOTES_MODES.include?(mode) ? mode : DEFAULTS['notes_mode']
      end

      def notes_shared?
        notes_mode == 'shared'
      end

      def integer(name, min: 0, max: nil)
        value = all[name].to_i
        value = DEFAULTS[name].to_i if value < min
        value = max if max && value > max
        value
      end

      def poll_active_ms
        integer('poll_active_ms', min: 250)
      end

      def poll_idle_ms
        integer('poll_idle_ms', min: 250)
      end

      def poll_hidden_ms
        integer('poll_hidden_ms', min: 1000)
      end

      def long_poll_seconds
        integer('long_poll_seconds', min: 0, max: LONG_POLL_MAX_SECONDS)
      end

      def compact_after
        integer('compact_after', min: 10)
      end

      def draft_ttl
        integer('draft_ttl_minutes', min: 1).minutes
      end

      # What the browser needs to know, serialized into the page head.
      def client_config
        {
          pollActiveMs: poll_active_ms,
          pollIdleMs: poll_idle_ms,
          pollHiddenMs: poll_hidden_ms,
          longPoll: long_poll_seconds.positive?,
          compactAfter: compact_after,
          notesMode: notes_mode,
          targets: %w[issue_description issue_notes journal_notes wiki].select { |k| enabled?(k) }
        }
      end
    end
  end
end
