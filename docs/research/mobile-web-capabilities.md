# Mobile web capabilities for cooking mode

Research for the ticket "Research: mobile web capabilities for cooking mode". The date is 2026-09-24. The current versions are **iOS / Safari 26.x** (caniuse also lists 27.x previews) and **Chrome for Android 152**.

The question: what can an installable PWA reliably do on iOS Safari and Android Chrome to support cooking mode? The areas covered are wake lock, hands-free voice, timers that alert in the background, and offline storage.

## Short answer

| Capability | iOS (installed to the Home Screen) | Android Chrome (installed or in a tab) | Fallback |
|---|---|---|---|
| Screen Wake Lock | **Yes.** It works in Home Screen web apps from iOS 18.4. On 16.4–18.3 it only worked in a Safari tab. | **Yes**, since Chrome 84. | Show a "keep screen on" toggle, and re-acquire the lock on `visibilitychange`. On old iOS, tell the user to change Auto-Lock or open the app in a Safari tab. |
| Voice commands (Web Speech recognition) | **Not reliable.** The API is prefixed, uses Siri's engine (server-based), needs Siri/Dictation enabled, and is officially "not available" in Home Screen apps. Some reports say it runs there anyway, but with bugs. | **Works, with limits.** It is server-based (needs network). `continuous` has no effect, so the app has to restart recognition after every phrase. The on-device mode (`processLocally`) is desktop Chrome 139+ only, not Android. | Large tap targets / a "tap anywhere for next step" mode. Voice is progressive enhancement that is offered only when feature detection passes. Keep the voice commands few and short. |
| Timer alert while locked or in the background | **Not from the page.** JS is suspended when the app goes to the background, and there is no API to schedule a local notification. Web Push works for Home Screen apps from iOS 16.4, but it needs a server to send the push at the right moment. There is no Vibration API. | **Not reliable from the page.** Hidden pages get throttled (1 s timer checks, then 1 min after 5 min hidden) and can be frozen. Scheduled local notifications (Notification Triggers) were abandoned. Web Push works, but again needs a server. Vibration works only while the page is visible. | Keep the screen on and the app in the foreground while cooking (wake lock), and store the timer as an absolute end time so it shows correctly when the user comes back. Alert with sound + an in-page banner (+ vibration on Android). Optional: a server-sent Web Push at the end time, as an upgrade. |
| Offline / storage | **Good once installed.** A Home Screen app has its own storage, with the same quota as Safari (up to about 60% of disk per origin). The 7-day ITP wipe does not apply to installed web apps. Data can still be evicted under storage pressure (LRU). | **Good.** Up to 60% of disk per origin. LRU eviction under pressure unless `navigator.storage.persist()` is granted. | Call `navigator.storage.persist()`. Treat the server as the source of truth and the local cache as rebuildable. On iOS, tell the household to install to the Home Screen, not only use Safari. |

**What this means for cooking mode:** screen-on plus foreground is the reliable design on both platforms. Wake lock keeps the page visible, so in-page timers, sounds and (on Android) vibration all keep working. Hands-free voice can be shipped as an optional extra on Android and in an iOS Safari tab. It must not be the main way to control cooking mode, because it is flaky or unavailable in the installed iOS app. Alerts for a locked phone need a server-sent push, which is a separate decision (it also has to fit the $0 budget).

## Screen Wake Lock API

- **iOS:** Safari 16.4 added the API, but it did "not work in standalone Home Screen Web Apps" until 18.4 (MDN browser-compat-data, `api.WakeLock`, citing [WebKit bug 254545](https://webkit.org/b/254545#c32)). The [WebKit Safari 18.4 release notes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) say: "The Screen Wake Lock API now also works in Home Screen Web Apps on iOS and iPadOS 18.4", and they use recipe viewers as the example.
- **Android Chrome:** supported since Chrome 84 (MDN BCD). [caniuse](https://caniuse.com/wake-lock) shows full support in Chrome for Android 152 and in Safari iOS 16.4+.
- **How it behaves** ([MDN, Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)):
  - It needs a secure context (HTTPS).
  - The `screen-wake-lock` Permissions-Policy defaults to `self`.
  - The lock is released automatically when the document becomes hidden or inactive, or on low battery or power-save mode. A request can be rejected for the same reasons.
  - The app must re-request the lock on `visibilitychange`.
- **Fallback:** a manual "keep screen on" toggle that shows whether the lock is active. The older trick of playing a hidden looping video (e.g. the NoSleep.js approach) is not a primary-source-backed technique. Don't use it on 18.4+.

## Web Speech API (speech recognition)

### iOS Safari

- Speech recognition shipped in Safari 14.1 on macOS and 14.5 on iOS, as `webkitSpeechRecognition` ([caniuse](https://caniuse.com/speech-recognition) marks it "partial"). It is "powered by the same speech engine as Siri", and "users will need Siri enabled … in Settings in iOS or iPadOS for the API to be available" ([WebKit, Safari 14.1 features](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/)). So it goes through Apple's servers and needs a network.
- `continuous` has been properly supported since Safari 17. Before that, it returned multiple results even when set to `false` (MDN BCD).
- `processLocally`, `available()`, `install()` and `phrases` are **not supported** in Safari (MDN BCD).
- **Home Screen apps:** [WebKit bug 225298](https://bugs.webkit.org/show_bug.cgi?id=225298) (resolved LATER) has a WebKit engineer saying that "SpeechRecognition API is not available in SafariViewController and web apps added to Home Screen for now". Follow-up comments run to March 2025, with no fix announced. A newer report, [WebKit bug 321436](https://bugs.webkit.org/show_bug.cgi?id=321436) (NEW, iOS 26), describes recognition starting in standalone mode (the mic indicator turns on) but no longer producing any `result`/`error`/`end` events after an `<audio>`/`<video>` element has played. **Result:** it may be exposed, but it is unsupported and buggy in the installed app. That is fatal for a "say 'next'" design that also plays a timer sound.
- **Permission prompts:** the user sees a microphone permission prompt and a speech-recognition permission prompt. Siri/Dictation must be on (WebKit 14.1 post). The exact prompt wording was not checked in a primary source.

### Android Chrome

- `webkitSpeechRecognition` has been supported since Chrome 33 on desktop. The Android entry mirrors desktop (MDN BCD). Chrome uses "server-based engines, meaning audio is sent to a web service and won't work offline" ([MDN, SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)).
- `continuous` is **not supported on Chrome Android**: "The property can be set, but has no effect" (MDN BCD, [crbug 41297427](https://crbug.com/41297427)). Recognition ends after each phrase, so the app has to call `start()` again in `onend`. The user sees the mic indicator, and there may be a gap in listening each time recognition restarts.
- On-device recognition (`processLocally`, `SpeechRecognition.available()` / `install()`) shipped in **desktop** Chrome 139. `phrases` (contextual biasing) shipped in desktop 142. All of these are marked **not supported on Chrome Android** (MDN BCD; [MDN, Using the Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API); Chrome Platform Status [On-device Web Speech API](https://chromestatus.com/feature/6090916291674112), where the Android milestone is empty). A follow-up, "On-Device Recognition Quality" (`quality: 'command' | 'dictation' | 'conversation'`), is Proposed for desktop 150 ([chromestatus](https://chromestatus.com/feature/5136859632107520)).
- **Permission:** the standard microphone permission prompt for the origin.

### Alternatives

- **An on-device model in the page** (e.g. a small keyword-spotting model running in WASM or WebGPU, which gets audio from `getUserMedia`): this avoids the network and the Web Speech gaps. But on both platforms the mic stream stops when the page is hidden, and on iOS it adds weight to the app and uses more battery. Not checked against a primary source here. It needs a prototype if hands-free is essential.
- **Non-voice hands-free:** very large tap zones (tap anywhere with a knuckle or elbow for next) work everywhere and need no permissions.

## Timers that alert in the background

- **Page JS in the background:** Chrome throttles timers on hidden pages to 1 check per second, and to 1 per minute after 5 minutes hidden and silent ([Chrome 88 timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). Pages that played sound in the last 30 s are exempt from intensive throttling. Browsers can also **freeze** hidden pages, and then "JavaScript timers and fetch callbacks don't run" ([Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)). iOS suspends Home Screen apps when they go to the background, and even audio stops ([WebKit bug 198277](https://bugs.webkit.org/show_bug.cgi?id=198277)).
- **Scheduled local notifications:** Chrome's Notification Triggers API (`showTrigger: new TimestampTrigger(...)`) is **discontinued**: "It wasn't clear that we could provide consistent and reliable experiences across platforms" ([Chrome docs](https://developer.chrome.com/docs/web-platform/notification-triggers)). No browser offers a replacement.
- **Web Push:**
  - **iOS/iPadOS 16.4+:** Web Push works only for web apps added to the Home Screen with `display: standalone` or `fullscreen`, and permission must be requested "in response to direct user interaction" ([WebKit, Web Push for Web Apps on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). The Badging API is also available. `Notification` is undefined outside Home Screen apps, and notifications can only be shown from a service worker (MDN BCD). iOS 18.4 added **Declarative Web Push**, which shows the notification without running a service worker ([Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/), [Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)). All of these still need a **server to send the push**. None of them let the page schedule a notification for later on the device.
  - **Android:** Push has been supported since Chrome 42, and notifications only come from a service worker (MDN BCD). It also needs a server.
- **Vibration:** not supported on iOS in any version. It is supported on Chrome Android ([caniuse](https://caniuse.com/vibration)), but only while the page runs.
- **Conclusion:** a timer running in the page cannot reliably alert when the phone is locked or the app is in the background, on either platform. The reliable pattern is:
  1. Keep the screen on (wake lock) and the app in the foreground during cooking mode.
  2. Store each timer's absolute end time, so a timer that was suspended shows the correct state as soon as the app is visible again.
  3. Alert with in-page sound + a visual banner, and also vibrate on Android.
  4. Optionally, add server-sent Web Push at the timer's end time. This is a real backend feature (a subscription store plus a scheduler) that has to fit the $0 budget. iOS needs the app installed to the Home Screen and a tap to grant permission.

## PWA install and offline storage

- **Quota:** WebKit (macOS 14+ / iOS 17+) allows an origin up to about 60% of disk in browser apps. A Home Screen web app "has the same origin quota and overall quota as when it is opened in a browser app" ([WebKit, Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/); [MDN, Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). Chrome also allows up to 60% of disk per origin (MDN).
- **Eviction on iOS:** WebKit evicts by origin in LRU order when over quota or under storage pressure, "or when the site has not been interacted with by the user for some time" (WebKit storage policy post). Safari's ITP 7-day cap deletes all script-writable storage (IndexedDB, Cache API, SW registration) after 7 days of Safari use with no interaction. But "Web applications added to the home screen are not part of Safari and thus have their own counter of days of use", and WebKit does "not expect the first-party in such a web application to have its website data deleted" ([WebKit, Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/); also [web.dev, Storage for the web](https://web.dev/articles/storage-for-the-web)). The installed app's storage is **separate from Safari's**. Data is not shared, so the user signs in again after installing (web.dev).
- **Persistence:** `navigator.storage.persist()` has been in Safari since 15.2 and in Chrome since 55 (MDN BCD). Both browsers grant or deny it silently, based on how much the user has interacted with the site, with no prompt (MDN). Chrome exempts persisted origins from LRU eviction.
- **Fallback:** ask the household to install to the Home Screen (iOS needs this for push, and it avoids the 7-day wipe). Call `persist()`. Design the offline cache so it can always be rebuilt from the server.

## Open items / not verified here

- The exact wording of the iOS speech-recognition permission prompt, and whether recognition in a Home Screen app works on current iOS 26.x. The WebKit bugs disagree, so this needs an on-device test.
- Whether an on-device keyword-spotting model in WASM is fast enough on mid-range phones. This would be a prototype question.
- Chrome Android's exact rules for freezing background tabs (not documented on the primary pages above).
