# Warp Notifications for Pi

Project-local Pi extension that sends OSC 777 notifications for Warp when Pi finishes a turn or needs a user answer.

## Events

- `agent_end`: sends a completion/error notification with model, duration, tool count, last action, and a short final-response preview.
- `ask_user` tool call: sends an immediate attention notification and plays a sound.

## Sound

On macOS the extension uses `afplay` with built-in system sounds:

- completion/test: `/System/Library/Sounds/Pop.aiff`
- attention/error: `/System/Library/Sounds/Glass.aiff`

Environment flags:

- `PI_WARP_NOTIFICATIONS=0` disables notifications.
- `PI_WARP_NOTIFICATIONS_SOUND=0` disables all sound.
- `PI_WARP_NOTIFICATIONS_COMPLETE_SOUND=0` disables completion sound.
- `PI_WARP_NOTIFICATIONS_ATTENTION_SOUND=0` disables attention/error sound.
- `PI_WARP_NOTIFICATIONS_COMPLETE_SOUND_PATH=/path/to/file.aiff` overrides completion sound.
- `PI_WARP_NOTIFICATIONS_ATTENTION_SOUND_PATH=/path/to/file.aiff` overrides attention sound.

## Manual test

After `/reload`, run:

```text
/warp-notify-test
```

Warp can also be tested directly with:

```bash
printf '\033]777;notify;Pi test;Notification from terminal\007'
```
