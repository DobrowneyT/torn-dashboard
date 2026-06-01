## Dashboard

## OC

### Tier Requirements

### Payouts

## RW

### Payouts

### War Room
- Request assistance in a fight (likely needs in-game script + API-hook)
- Incorporate Roll Call into the War Room. Add a "Check-in" feature.

## General
- Generate a CHANGELOG.md with versioning (using semvar)
- Add a copyright or something at the bottom of the page "Designed by MonChoon. Copyright 2026. Version X.Y.Z" something like that, and have a script parse the CHANGELOG for the most recent version in Git everytime its pushed, build that into the `deploy-pages.yml` so the script runs, checks changelog, updates the version at the bottom of this page (maybe a general "footer" for all pages), and the deploys the page as usual.