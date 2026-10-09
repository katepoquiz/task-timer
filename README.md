# Task Timer

A small desktop timer for tracking time on tasks and projects. Runs as an installed Chrome app on Windows, works offline, and keeps all data on your computer.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Look and feel, light and dark themes |
| `app.js` | Screens, buttons, reminders, history |
| `store.js` | Saving data and the timer rules (one active timer, never lose a session) |
| `time.js` | Time math and formatting |
| `sw.js` | Offline support and notification buttons |
| `manifest.webmanifest`, `icons/` | What makes Chrome treat it as an installable app |

No build step, no libraries, no accounts.

## Step 1: Put it at a web address (one time)

Chrome only installs apps from a real web address (https) or from `localhost`. Pick one.

### Recommended: GitHub Pages (free, about 5 minutes)

1. Create a free account at github.com.
2. Click **New repository**, name it `task-timer`, set it to **Public**, and create it.
3. Click **uploading an existing file**, drag in everything from this folder (including the `icons` folder), and click **Commit changes**.
4. Go to **Settings > Pages**. Under **Branch**, choose `main` and `/ (root)`, then **Save**.
5. After a minute, your app is at `https://YOUR-USERNAME.github.io/task-timer/`.

The code is public. Your time data is not: it never leaves your computer.

### Alternative: run it on your own PC

If Python is installed, open a terminal in this folder and run:

```
python -m http.server 8765
```

Then open `http://localhost:8765`. After you install the app, it keeps working with the server turned off. Always use the exact same address, because your data is tied to it.

## Step 2: Install it in Chrome

1. Open your app's address in Chrome.
2. Click the **Install** icon at the right end of the address bar (a monitor with a down arrow). Or open the **⋮** menu > **Cast, save, and share** > **Install Task Timer**.
3. Click **Install**. The app opens in its own window with no tabs or address bar.

This creates a real installed app, not just a browser bookmark. It gets its own window, its own taskbar icon, a Start menu entry, and it shows up in Windows **Settings > Apps**. It still runs on Chrome's engine, so keep Chrome installed.

## Step 3: Make it one click away

- **Pin to taskbar (recommended):** open the app, right-click its taskbar icon, choose **Pin to taskbar**. While a timer runs, a dot appears on this icon.
- **Desktop icon:** Chrome usually adds one. If not, go to `chrome://apps`, right-click Task Timer, choose **Create shortcuts**, and tick **Desktop**.
- **Open at sign-in (optional):** in `chrome://apps`, right-click Task Timer and turn on **Start app when you sign in**.

## Recommended Chrome settings

- **Keep it awake:** Chrome **Settings > Performance > Always keep these sites active > Add**, and enter your app's address. This stops Chrome from putting the app to sleep in the background, which would delay reminders.
- **Notifications:** in the app, click the gear and tick **Also show a Windows notification**. If Windows Focus Assist / Do Not Disturb is on, Windows will hold the notification back.

## How it protects you from forgotten timers

- The timer panel, the line under the header, the window title, and the taskbar dot all show when a timer is running.
- After the reminder interval (60 minutes by default, set in the gear menu), an in-app banner and a Windows notification ask if you're still working. The notification has **Pause** and **Stop** buttons. The timer never stops by itself.
- If the app was closed or the PC was asleep while a timer ran, the app asks on return: keep the time, remove the gap and keep timing, or stop and save at the moment you left.
- Elapsed time comes from saved start and pause times, so it stays accurate through minimizing, refreshes, closing, and sleep.

## Your data: where it lives and how to lose it

Data is saved in Chrome's storage, on this computer, in this Chrome profile, for this exact web address. It's saved after every action.

You will lose it if you:

- Clear browsing data with **Cookies and other site data** selected (for all time, or for this site).
- Uninstall the app and choose to also clear its data.
- Switch computers, Chrome profiles, or browsers, or move the app to a different web address.

To stay safe, use **gear > Download backup** once a week. **Restore from backup** only adds missing sessions. It never deletes anything.

## Limitations

- **Reminders need the app window open** (minimized is fine). A closed web app can't run any code. The timer itself stays accurate either way, and the return prompt catches forgotten time.
- **No direct Zoho sync.** Use **History > Export CSV**. It includes decimal hours for easy entry.
- A session that runs past midnight counts toward the day it started.

## Updating the app

If you change any file, open `sw.js` and bump `VERSION` (for example `v1.0.0` to `v1.0.1`), then upload the files again. Installed copies update the next time you open the app (sometimes the time after).
