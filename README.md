# PV Intake & Triage Console

Adverse-event intake and triage workflow demo for pharmacovigilance.

**Live demo:** https://r6j9p36xbegaek4lcdp5268p.macaly.app

> This is a fictional, educational demonstration. Do not use it for real patient data, clinical decisions or regulatory submissions.

## Features
- Public adverse-event report form with a reference number for each report
- Automatic classification: serious / expected / expedited, with 7-day and 15-day reporting clocks
- Email confirmation to the reporter and alerts to the safety team
- Sign-in-gated team dashboard with tasks, status tracking and an audit log
- Possible-duplicate flags, event-term suggestions and deadline reminders
- Follow-up queries sent to reporters

## Tech stack
TanStack Start, React, Tailwind CSS, Convex (database, auth, scheduled jobs). Built on Macaly Cloud.

> The live demo's database and email features may differ from what you run yourself; you would need to set up your own Convex project and email provider.

## Attribution
Created by **Khan Gulrez Shagufa Fazal Ahmed**.

If you reuse or adapt this project, please credit the original author and link back to https://github.com/randomthingsonlineatsk-cloud/pv-intake-triage-console. The Apache License 2.0 requires you to keep the `LICENSE` and `NOTICE` files with any copy you distribute.

## License
Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Khan Gulrez Shagufa Fazal Ahmed.
