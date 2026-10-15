# Iron Jiyu Tracker

A punch-in / punch-out time tracker for work, in one HTML file.

## Features

- **Punch clock**: type what you're working on, pick a project, then punch in. A running timer survives reloads.
- **Projects**: color-coded, renameable, archivable. Archived projects keep their past entries.
- **Today / this week totals**: shown in both `H:MM` and decimal hours (timesheet style), plus progress toward a weekly goal (default 40 h).
- **Week chart**: hours per day, stacked by project, with a daily target line (weekly goal ÷ 5).
- **Time card**: entries grouped by day. Edit, delete, restart a task, or add time you forgot to track. An end time before the start counts as past midnight.
- **CSV export**: exports the selected week as a timesheet (Date, Start, End, Hours, Duration, Project, Description).

## Where data is saved

- **As a claude.ai artifact**: entries are saved to your account, privately (under your own `data/users/<id>/` path). Each signed-in person who opens it gets their own separate time card.
- **Opened as a plain file** (`index.html` in a browser): entries are saved in that browser's `localStorage`.
