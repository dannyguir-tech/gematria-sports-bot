# Kalshi Gematria Bot

A Tampermonkey userscript that adds a floating gematria calculator to [Kalshi](https://kalshi.com) sports markets.

## What it does

- Adds a draggable panel to any Kalshi page
- Calculates English ordinal gematria (A=1, B=2, …, Z=26) and full reduction values
- Lets you enter two market sides and an optional date
- Suggests a pick based on the numbers
- Tries to auto-detect team/market names from the page title

## Install

1. Install the [Tampermonkey extension](https://www.tampermonkey.net/) in your browser.
2. Click the raw `kalshi-gematria-bot.user.js` file in this repo.
3. Tampermonkey will prompt you to install the script.

Or copy the contents of `kalshi-gematria-bot.user.js` into a new Tampermonkey script.

## How to use

1. Open any Kalshi sports market page.
2. The Gematria Bot panel appears on the top-right.
3. Enter Side A and Side B (team names, player names, or market titles).
4. Optionally enter the event date.
5. Click **Calculate**.

## Pick logic

1. If one side's reduced value matches the reduced date value, that side is the pick.
2. Otherwise, the side with the higher ordinal gematria value is the pick.
3. If both values are equal, it's a tie.

## Disclaimer

This is for entertainment only. Gematria is not a proven betting or trading strategy. Do not risk money based on this script.
