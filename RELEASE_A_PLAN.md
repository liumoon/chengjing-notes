# Release A implementation split

Release A focuses on operational safety and diagnostics around the Markdown/document-import work already shipped on `main`.

## Scope and file list

1. Attachment health center
   - Add `src/lib/attachmentHealth.ts` for reference scanning, issue classification, and orphan cleanup.
   - Add `src/lib/attachmentHealth.test.ts` for referenced/history/orphan cases.
   - Add `src/components/AttachmentHealthPanel.tsx` and mount it in `SettingsView`.
2. Import transaction hardening
   - Harden `src/lib/attachments.ts` so a failed IndexedDB write removes a file-backed attachment created by the bridge.
   - Harden `src/lib/importPipeline.ts` to report cleanup failures instead of silently hiding them.
   - Extend `src/lib/importBatch.test.ts` with a card-save failure regression.
3. LAN AI diagnostics
   - Add structured diagnostic stages to `electron/provider-client.cjs`.
   - Localize the diagnostic result in `electron/provider-errors.cjs` and `src/lib/advancedProviderCopy.ts`.
   - Show a safe diagnostic summary in `src/components/AdvancedAIProviderSettings.tsx`.
   - Extend `electron/provider-settings.node.cjs` and add provider-client node coverage.
4. Backup preflight
   - Add `inspectBackup()` to `src/lib/backupValidation.ts`.
   - Show counts, attachment warnings, and version information before local/cloud restore.
   - Add regression coverage in `src/lib/backupPreflight.test.ts`.
5. Sync observability
   - Extend `src/lib/syncActivity.ts` with retry/category metadata.
   - Surface pending attachment counts and categorized errors in `src/components/SyncSettings.tsx`.
   - Preserve the existing sync protocol and tables.

## Implementation status

- [x] Attachment health center, history-aware orphan detection, and localized cleanup UI.
- [x] Per-document import cleanup with native-file rollback attempts and cleanup diagnostics.
- [x] LAN AI provider diagnostics for URL, connection, API path, HTTP status, and model availability.
- [x] Backup restore preflight for local and cloud restore flows, while preserving safety copies.
- [x] Sync error classification, retry guidance, pending attachment counts, and attachment-safe failure handling.
- [x] Five-language copy for the Release A surfaces.

## Compatibility constraints

- Keep `contentHtml` as the only stored card content field.
- Keep `AttachmentRecord.role` optional and avoid Dexie migrations.
- Keep old JSON backup versions and the existing safety-copy restore flow compatible.
- Only clean attachments with no current-card, card-version, or inline-body reference.
- Keep public HTTP AI endpoints rejected; private LAN HTTP remains allowed.

## Verification

- `npm run typecheck` — passed
- `npm test` — passed: 56 Vitest files / 248 tests and 79 Electron node tests
- `npm run build` — passed
- `git diff --check` — passed
