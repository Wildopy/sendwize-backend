# Archived pages

Not deployed (only `public/` is served). Kept so they can be fixed and restored later.

- `index.html`: PECR questionnaire. Posts to `/api/submit-check` without an `action`, which the API rejects.
- `violation-browser.html`: calls `/api/get-violations`, which doesn't exist.
- `reconsent-builder.html`: sends `companyName`/`industry`, but `/api/generate-reconsent-email` expects `senderName` and other fields. Re-consent drafts live in List health (`/api/list-intelligence?action=draft-reconsent`).

To restore one: fix it, then `git mv archive/<page>.html public/`.
