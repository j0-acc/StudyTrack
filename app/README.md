# StudyTrack Android app (APK)

This folder turns the StudyTrack website into an Android app with **Capacitor 8**.
The app is built **from the website files in the folder above**, so every fix you make to the
website goes into the next APK automatically. Admin pages are left out (admins use the website).

```
StudyTrack/            <- your website folder (login.html, js/, css/ ...)
└── app/               <- this folder
    ├── package.json
    ├── capacitor.config.json
    ├── scripts/build-web.mjs   (copies the website into www/)
    ├── www-extra/              (the app's start screen)
    └── assets/logo.png         (the app icon)
```

## What you need (one time)

1. **Node.js 22 or newer** – https://nodejs.org (choose the LTS version).
2. **Android Studio Otter (2025.2.1) or newer** – https://developer.android.com/studio
   Open it once and finish the setup wizard (it installs the Android SDK and Java for you).
3. Make sure `js/config.js` in the website folder has your real Supabase URL and anon key.

## Build the APK

Open a terminal **in this `app` folder** (in VS Code: right-click the folder → *Open in Integrated Terminal*).

```bash
npm install                 # downloads Capacitor and the libraries (first time only, needs internet)
npm run build               # copies the website into www/
npx cap add android         # creates the Android project (first time only)
npm run icons               # makes the app icon from assets/logo.png (first time, or when the icon changes)
npx cap sync android        # copies www/ into the Android project
npx cap open android        # opens Android Studio
```

In Android Studio:

1. Wait until the bottom bar finishes **"Gradle sync"** (the first time can take 5–10 minutes).
2. Menu **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.
3. When it says *"APK(s) generated successfully"*, click **locate**. The file is
   `android/app/build/outputs/apk/debug/app-debug.apk`.

## Install it on a phone

- Send `app-debug.apk` to the phone (USB, Google Drive, Messenger...).
- Open it on the phone. If Android asks, allow **"Install unknown apps"** for that app.
- Or plug the phone in with USB debugging on and press the green **Run ▶** button in Android Studio.

## After you change the website

```bash
npm run sync                # = npm run build + npx cap sync android
```
Then build the APK again in Android Studio (**Build → Build APK(s)**).

## What works offline

| Works without internet | Needs internet |
|---|---|
| Opening the app when already signed in | Signing in for the first time |
| Decks, cards, dashboard, statistics you opened before (last saved copy) | AI card generation |
| Flashcard study (study time is sent later) | Challenges, live matches, leaderboard |
| **Writing, editing, pinning and deleting notes** (sent automatically when back online) | Saving new decks and cards, quizzes |
| **Importing a PDF**: the text is kept and a "Generate now" reminder appears when you are back online | |

A dark **Offline** label appears in the top bar when there is no internet, with how many changes are waiting.

## Optional: a signed release APK

The debug APK is fine for demos and testing. For a release version:
**Build → Generate Signed App Bundle or APK → APK**, create a new key store (keep the file and passwords safe),
choose **release**, and finish. Upload to the Play Store needs the **App Bundle (.aab)** option instead.

## If something goes wrong

- **"Could not find the StudyTrack website"** – this `app` folder must be inside the website folder, next to `login.html`.
- **Gradle errors about Java/JDK** – in Android Studio: *Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK* → choose the bundled **jbr-21**.
- **White screen in the app** – run `npm run sync` again, then rebuild. Check `js/config.js` has the real keys.
- **App name / id** – change `appName` / `appId` in `capacitor.config.json` before `npx cap add android`.
