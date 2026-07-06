# Induced Operation Taxonomy v2 — bottom-up, empirical

Empirical, data-led induction over **173 real *exposed* operations** sampled from real
apps (fractal + pure-transport libs excluded). No prior category scheme imported: no CRUD,
no REST/HTTP verbs, no query/command, no safety/idempotency taxonomy. Categories and
dimensions below were named only *after* reading operation bodies.

Effect vocabulary used during harvest (the atoms, observed not imposed): `reads`,
`creates`, `mutates`, `deletes`, `external-effect`, `pure-compute`. Every effect an op
exhibits is listed — not just one.

## Corpus size & per-app counts

| App | Surface | Ops |
|---|---|---|
| the consumer app | use-cases (billing/marking/approvals/ingestion/triggers/messages/outreach/payments) | 30 |
| the consumer app | use-cases (hr/hiring/enrolment/lessons/sessions/classes/knowledge/nps/leads/forecasting/kpis/accounting) | 33 |
| the consumer app | CLI + HTTP routes + worker projections/secretEffects | 31 |
| normalize | CLI commands + normalize-tools MCP adapters | 25 |
| curilo-for-parents | Supabase edge functions | 26 |
| interconnect | daemon RPC | 5 |
| reincarnate | CLI subcommands | 4 |
| rescribe | CLI subcommands | 2 |
| myenv | CLI subcommands | 4 |
| claude-code-hub | HTTP routes + MCP tools | 8 |
| chub-moderate | pipeline stages | 5 |
| **Total** | | **173** |

## Single-effect vs multi-effect tally — THE central finding

Counting each op's distinct effect atoms:

| Cluster | single-effect | multi-effect |
|---|---|---|
| the consumer app use-cases b1 | 6 | 24 |
| the consumer app use-cases b2 | 11 | 22 |
| the consumer app CLI/HTTP/worker | ~12 | ~19 |
| normalize | 0 | 25 |
| curilo | 3 | 23 |
| interconnect/reincarnate/rescribe/myenv/cch/chub | 7 | 21 |
| **Total** | **~39 (23%)** | **~134 (77%)** |

**Verdict: "one kind per operation" does not survive contact with the corpus.** ~77% of
sampled ops carry two or more distinct effect atoms; normalize has *zero* pure single-effect
exposed ops (every op reads source and pairs it with compute, a subprocess, or a write).
The clearest refutation is a single handler exhibiting the whole create/mutate/delete
quartet at once (`award-progress`: reads+creates+mutates+deletes). Operations are therefore
best described as a **vector/set of effects**, not assigned a single "kind."

---

## FULL CORPUS (every op, cited)

Format: `NAME | one-line | signature | effects | file:line`

### the consumer app — billing / marking / approvals / ingestion / triggers / messages / outreach / payments

- createCreditNote | reads invoice+payer contact, writes credit-note row AND a negative payment row, emails payer via outbox, publishes CREDIT_NOTE_ISSUED | {invoiceId,amountCents,reason,issuedByUserId?} -> Result<{creditNoteId}> | [reads,creates,external-effect] | packages/billing/src/application/v1/createCreditNote.ts:33
- issueRefund | validates against paid-minus-refunded; for non-manual processors calls gateway refund adapter, records refund row, publishes INVOICE_REFUND_ISSUED | {invoiceId,amountCents,reason,processor,gatewayReference?,issuedBy} -> Result | [reads,creates,external-effect] | packages/billing/src/application/v1/issueRefund.ts:60
- chargeInstalment | attempts one gateway charge on a pending instalment; success marks paid+records payment, failure increments retry_count and flags at MAX | {instalmentId,instalment?} -> Result | [reads,creates,mutates,external-effect] | packages/billing/src/application/v1/chargeInstalment.ts:111
- sendOverdueReminders | lists overdue invoices, enqueues weekly-bucketed reminder emails via outbox, publishes INVOICE_OVERDUE per invoice | (clock,deps) -> void | [reads,external-effect] | packages/billing/src/application/v1/sendOverdueReminders.ts:10
- autoApplyPromoForInvoice | finds first matching auto-apply promo, creates single-use discount code, records redemption, applies discount line; idempotent per (campaign,subject) | {invoiceId,subjectId,payerId,correlationId,isTrial} -> Result | [reads,creates,mutates] | packages/billing/src/application/v1/autoApplyPromoForInvoice.ts:125
- reconcileGatewaySettlement | reconciles gateway settled/failed event vs own invoice; idempotent on gatewayReference; records payment, marks paid/overdue, upserts payment-status, publishes PAYMENT_RECORDED | {invoiceId,outcome,...} -> Result | [reads,creates,mutates,external-effect] | packages/billing/src/application/v1/reconcileGatewaySettlement.ts:48
- voidInvoice | guards not-paid/not-already-voided, voids invoice row, publishes INVOICE_VOIDED | {invoiceId,reason,replacedById?} -> Result<void> | [reads,mutates,external-effect] | packages/billing/src/application/v1/voidInvoice.ts:26
- gradeHomeworkSubmission | loads submission, writes grade+feedback+reviewer onto it | {submissionId,grade,feedback,reviewedBy} -> Result<void> | [reads,mutates] | packages/marking/src/application/v1/gradeHomeworkSubmission.ts:28
- draftMarkingFeedback | RAG: retrieves context chunks, calls LLM generateObject to draft feedback, saves draft on job, publishes event | {jobId,...} -> Result | [reads,mutates,external-effect] | packages/marking/src/application/v1/draftMarkingFeedback.ts:36
- sendProgressReportToParent | **despite the name, only loads the report and stamps it sent (no email/outbox)** | {reportId} -> Result<{sentAt}> | [reads,mutates] | packages/marking/src/application/v1/sendProgressReportToParent.ts:17
- reassignMarkingJob | loads job, reassigns to new tutor; **outbox/eventBus are in deps but never invoked** | {jobId,tutorId} -> Result<void> | [reads,mutates] | packages/marking/src/application/v1/reassignMarkingJob.ts:16
- ingestMarkedWork | stores submission buffer in blob storage, creates marking job row, publishes event | {submissionBuffer,...} -> Result | [creates,external-effect] | packages/marking/src/application/v1/ingestMarkedWork.ts:43
- approveRequest | loads request, transitions pending->approved (optimistic), publishes decision event | {id,...} -> Result | [reads,mutates,external-effect] | packages/approvals/src/application/v1/approveRequest.ts:83
- enqueueApproval | creates new pending approval-request row, publishes enqueued event | {...} -> Result<ApprovalRequestId> | [creates,external-effect] | packages/approvals/src/application/v1/enqueueApproval.ts:63
- expireApprovals | lists pending-expired candidates, transitions each to expired, publishes event per expiry | (now-driven) -> Result | [reads,mutates,external-effect] | packages/approvals/src/application/v1/expireApprovals.ts:60
- confirmImport | per-row importer dispatching into leads/enrolment/hiring/billing use-cases; tallies created/updated/skipped/errors | {rows,entity,skipRows} -> Result | [reads,creates,mutates,external-effect] | packages/ingestion/src/application/v1/confirmImport.ts:133
- extractFromText | calls LLM generate to extract structured ingestion rows from free text; [] if no llm dep | {text,...} -> Result<IngestionRow[]> | [external-effect] | packages/ingestion/src/application/v1/extractFromText.ts:114
- previewImport | pure: applies column mapping + cleans/validates each row; no deps, no I/O | {rows,columnMapping,entity,requiredFields?} -> Result | [pure-compute] | packages/ingestion/src/application/v1/previewImport.ts:70
- createTrigger | validates name/eventType/jobKind and JSON payloadTemplate, parses optional condition Expr, creates trigger row | CreateTriggerInput -> Result<Trigger> | [creates] | packages/triggers/src/application/v1/createTrigger.ts:45
- generateTriggerFromNL | calls LLM generateObject to synthesize a trigger from NL, one repair retry; pure validation, no DB | {nl,eventRegistry,...} -> Result | [external-effect] | packages/triggers/src/application/v1/generateTriggerFromNL.ts:273
- subscribeToDomainEvents | wires eventBus "*" subscription; per event loads matching enabled triggers, enqueues outbox jobs from payload templates | deps -> subscription | [reads,external-effect] | packages/triggers/src/application/v1/subscribeToDomainEvents.ts:94
- getTriggerRuns | reads run history for a trigger from outbox (newest first), degrades to empty | {id,limit} -> Result | [reads] | packages/triggers/src/application/v1/getTriggerRuns.ts:36
- broadcastMessage | resolves target users/students+parent contacts by filter, enqueues mail.send per recipient via outbox, logs each outbound row | BroadcastMessageInput -> Result | [reads,creates,external-effect] | packages/messages/src/application/v1/broadcastMessage.ts:44
- handleInboundMessage | marks an inbound message row as handled | {id} -> Result<{id}> | [mutates] | packages/messages/src/application/v1/handleInboundMessage.ts:15
- composeMessage | resolves recipient contact (+ last channel), enqueues mail.send or sms.send via outbox, logs outbound row | ComposeMessageInput -> Result | [reads,creates,external-effect] | packages/messages/src/application/v1/composeMessage.ts:36
- draftOutreach | loads prospect, calls LLM to draft outreach copy, sets prospect status "drafting", returns draft | {prospectId,...} -> Result<{draft}> | [reads,mutates,external-effect] | packages/outreach/src/application/v1/draftOutreach.ts:14
- recordOutcome | loads outreach record, updates outcome + advances prospect status, publishes outcome event(s) | {recordId,outcome} -> Result | [reads,mutates,external-effect] | packages/outreach/src/application/v1/recordOutcome.ts:32
- chargeMandate | loads invoice+active mandate, double-charge guard, calls GoCardless createPayment (idempotency-keyed), records gateway_payments row | {invoiceId,currency,description?} -> Result | [reads,creates,external-effect] | packages/payments/src/application/v1/chargeMandate.ts:46
- createCheckoutSession | loads invoice, pending-charge guard, calls gateway.createCheckout, records gateway_payments row, returns hosted URL | (invoiceId,deps) -> Result<{url}> | [reads,creates,external-effect] | packages/payments/src/application/v1/createCheckoutSession.ts:27
- handleGoCardlessWebhook | verifies webhook HMAC, dispatches per event: correlates payment->invoice + publishes PaymentSettled/Failed, updates mandate, invokes notify callback | (rawBody,signature,deps) -> Result<void> | [reads,mutates,external-effect] | packages/payments/src/application/v1/handleGoCardlessWebhook.ts:52

### the consumer app — hr / hiring / enrolment / lessons / sessions / classes / knowledge / nps / leads / forecasting / kpis / accounting

- approvePayroll | approves all draft payslips for a period, finalises pay_run aggregate, enqueues one payslip-issued email per tutor | {periodStart,periodEnd,approvedByUserId,baseUrl?} -> {payRun,approvedCount,notificationsEnqueued} | [reads,creates,mutates,external-effect] | packages/hr/src/application/v1/approvePayroll.ts:45
- approveTimesheetSubmission | approves a pending timesheet, then generates a draft payslip (payslip failure non-fatal) | {submissionId,approvedByUserId} -> {submissionId,payslip|null} | [reads,mutates,creates] | packages/hr/src/application/v1/approveTimesheetSubmission.ts:31
- approveAbsence | flips a pending absence to approved, publishes ABSENCE_APPROVED | absenceId -> {absenceId} | [reads,mutates,external-effect] | packages/hr/src/application/v1/approveAbsence.ts:22
- assemblePayslip | pure gross/OTE/super/PAYG/net math over earning lines | {earningLines,superRate,effectiveWithholdingBps} -> {gross,ote,super,taxWithheld,net} | [pure-compute] | packages/hr/src/application/v1/assemblePayslip.ts:35
- calculateTutorPay | computes one tutor's pay over a range from hr-owned session-facts read-model, applying casual/PAYG withholding | {tutorId,periodStart,periodEnd} -> TutorPaySummary | [reads] | packages/hr/src/application/v1/calculateTutorPay.ts:46
- assignShift | creates a shift row for tutor+lesson, publishes SHIFT_ASSIGNED | {tutorId,lessonId,startAt,durationMins} -> {shiftId} | [creates,external-effect] | packages/hr/src/application/v1/assignShift.ts:26
- advanceApplicant | reads pipeline stage, maps to next linear stage, delegates to progressApplicant (mails, referral bookkeeping, event) | {applicationId} -> ProgressApplicantOutput | [reads,mutates,external-effect] | packages/hiring/src/application/v1/advanceApplicant.ts:46
- completeOnboardingTask | stamps completed_at on a single onboarding task | {taskId} -> {} | [mutates] | packages/hiring/src/application/v1/completeOnboardingTask.ts:20
- getOrCreateReferralCode | returns tutor's referral code, generating+persisting a random base36 slug on first use (retries on collision) | {tutorId} -> {tutorId,referralCode} | [reads,mutates] | packages/hiring/src/application/v1/getOrCreateReferralCode.ts:25
- getApplicationsCsvExport | returns most recent 5000 applications for admin CSV export | {} -> ApplicationCsvExportRow[] | [reads] | packages/hiring/src/application/v1/getApplicationsCsvExport.ts:20
- approveAndSendFollowup | enqueues trial follow-up email, marks follow-up sent, publishes FOLLOWUP_SENT + TRIAL_COMPLETED | {trialId,editedText,approvedByUserId} -> void | [reads,mutates,external-effect] | packages/enrolment/src/application/v1/approveAndSendFollowup.ts:34
- convertToEnrolment | in one UoW creates an enrolment + enqueues confirmation email, publishes ENROLMENT_CONVERTED + STATUS_CHANGED | {trialId,studentId,parentId,subjects[],startDate} -> {enrolmentId} | [reads,creates,external-effect] | packages/enrolment/src/application/v1/convertToEnrolment.ts:33
- bulkSendInvoiceReminders | queries each student's outstanding invoices (cross-slice read), enqueues per-invoice reminder email, idempotent per invoice per day | {studentIds[]} -> {succeeded,failed,...} | [reads,external-effect] | packages/enrolment/src/application/v1/bulkSendInvoiceReminders.ts:47
- expireStaleTrials | cron: finds trials past expiry window, marks trial_expired, inserts admin_notification, publishes StudentLifecycleChanged per student | {expiryDays?} -> {expiredCount,expiredStudentIds} | [reads,creates,mutates,external-effect] | packages/enrolment/src/application/v1/expireStaleTrials.ts:52
- batchScheduleLessons | generates studentIds×weeks recurring lessons, skipping conflicts; preloads parent/enrolment, creates lessons, enqueues mail, publishes lifecycle | {tutorId,studentIds[],subject,...,recurrence} -> {created,lessonIds[],skipped[]} | [reads,creates,external-effect] | packages/lessons/src/application/v1/batchScheduleLessons.ts:110
- cancelLesson | sets a scheduled lesson to cancelled (404/409 guards), re-stamps lifecycle read-model via event | {lessonId,reason?} -> {lessonId} | [reads,mutates,external-effect] | packages/lessons/src/application/v1/cancelLesson.ts:31
- completeLesson | sets a scheduled lesson to completed (guards already/cancelled), re-stamps lifecycle | {lessonId} -> {lessonId} | [reads,mutates,external-effect] | packages/lessons/src/application/v1/completeLesson.ts:29
- assignSubstituteTutor | reassigns lesson tutor (resets to scheduled), emails substitute+parent, emits SUBSTITUTE_ASSIGNED, re-stamps lifecycle | {lessonId,substituteTutorId} -> {...,previousTutorId} | [reads,mutates,external-effect] | packages/lessons/src/application/v1/assignSubstituteTutor.ts:75
- createSession | creates a session row (class- or tutor-scoped), publishes SESSION_LIFECYCLE_CHANGED(scheduled) | {classId?|tutorId?,scheduledAt,...} -> Session | [creates,external-effect] | packages/sessions/src/application/v1/createSession.ts:32
- cancelSession | cancels a session, publishes SESSION_CANCELLED + LIFECYCLE_CHANGED(cancelled) | {sessionId,reason?,studentIds?,...} -> Session | [reads,mutates,external-effect] | packages/sessions/src/application/v1/cancelSession.ts:28
- generateSessionsForClass | parses class time slot, enumerates weekly dates, skips existing, creates each missing session + publishes lifecycle | {classId,from,to} -> {generated,skipped} | [reads,creates,external-effect] | packages/sessions/src/application/v1/generateSessionsForClass.ts:78
- findReplacementTutor | reads a session+its class, ranks a replacement tutor via hr-owned match port (read-only) | {sessionId} -> {tutorId,tutorName}|null | [reads] | packages/sessions/src/application/v1/findReplacementTutor.ts:55
- createClass | validates and inserts a class row | {subject,yearLevel,campus,...} -> Class | [creates] | packages/classes/src/application/v1/createClass.ts:65
- enrolStudentInClass | verifies class+student exist and no active enrolment, then enrols (may waitlist) | {classId,studentId,isTrial?} -> {enrolment,waitlisted} | [reads,creates] | packages/classes/src/application/v1/enrolStudentInClass.ts:31
- activateStance | flips a stance's active flag true | {id} -> {id} | [mutates] | packages/knowledge/src/application/v1/activateStance.ts:19
- handleInboundTurn | orchestrates one inbound conversational turn: resolve/idle-close conversation, idempotency-replay, append customer turn, compose LLM stance reply (or escalate), record assistant turn, flip mode, emit reply events | {channel,participantKey,text,...} -> InboundTurnOutcome | [reads,creates,mutates,external-effect] | packages/knowledge/src/application/v1/handleInboundTurn.ts:125
- sendDueSurveys | cron: per active NPS survey resolves recipient segment, honors cadence, creates invitation row per due user, enqueues invite email | {appUrl} -> {surveysProcessed,invitationsSent,invitationsSkipped} | [reads,creates,external-effect] | packages/nps/src/application/v1/sendDueSurveys.ts:42
- convertLead | marks a lead converted (guards not-found/already), publishes LEAD_CONVERTED | {id,correlationId?} -> Lead | [reads,mutates,external-effect] | packages/leads/src/application/v1/convertLead.ts:19
- getGrowthForecast | reads last-12-months enrolment counts, projects N months via least-squares regression + trend classification | {months?} -> GrowthForecast | [reads] | packages/forecasting/src/application/v1/getGrowthForecast.ts:62
- getDashboardKpis | reads 8 parallel repo aggregates, computes current-vs-prior trend percentages | () -> DashboardKpis | [reads] | packages/kpis/src/application/v1/getDashboardKpis.ts:43
- recordExpense | resolves open tax-category + rate, derives input-tax-credit, inserts expense row, best-effort publishes ExpenseRecorded | {description,amountCents,category,...} -> void | [reads,creates,external-effect] | packages/accounting/src/application/v1/recordExpense.ts:109
- reconcileWithXero | reads local invoices for period, matches vs caller-supplied external Xero invoices+bank txns, returns reconciliation report | (repo,externalInvoices[],externalBankTxns[],from,to) -> ReconciliationResult | [reads] | packages/accounting/src/application/v1/reconcileWithXero.ts:123
- getPnl | returns P&L summaries grouped by fiscal quarter | (repo) -> PnlSummary[] | [reads] | packages/accounting/src/application/v1/getPnl.ts:45

### the consumer app — CLI / HTTP routes / worker

- runBackup | dumps whole DB to a rotating SQL file, prints path + table/row/byte counts | {dir?}+Client -> void | [reads,creates(file),pure-compute] [batch] | apps/cli/src/commands/backup.ts:17
- runRestore | reads a SQL dump, prompts y/n, replays all statements into DB | {file,yes?,dir?}+Client -> void | [reads(file),reads(stdin),mutates,external-effect] [batch] | apps/cli/src/commands/backup.ts:37
- listBackupsCommand | lists backup files in a dir with timestamp/size | {dir?} -> void | [reads(fs),pure-compute] | apps/cli/src/commands/backup.ts:87
- dumpAudit | builds a filtered SELECT over audit_log, prints up to 500 rows as JSON | {entity?,from?,to?} -> void | [reads,pure-compute] | apps/cli/src/commands/dump-audit.ts:3
- migrate | derives full migration set from deployment composition, diffs vs _migrations, applies pending | Client -> void | [reads,mutates(DDL),external-effect] [batch] | apps/cli/src/commands/migrate.ts:17
- showActions | calls guidance.getActionItems, pretty-prints | GuidanceSlice -> void | [reads,pure-compute] | apps/cli/src/commands/actions.ts:3
- runPayroll | runs hr.runPayroll for a period, reads payslips count, prints gross/super summary | {period?}+deps -> void | [reads,creates,external-effect] [batch][async-job] | apps/cli/src/commands/run-payroll.ts:51
- doctor | checks required/optional env vars (masked), opens DB, SELECT 1, checks _migrations; exits nonzero on error | {dbUrl?} -> exit code | [reads(env),reads(db),pure-compute,external-effect] [config] | apps/cli/src/commands/doctor.ts:86
- advanceApplication | validates stage, calls hiring.progressApplicant | (appId,stage,{note?}) -> void | [mutates,external-effect] | apps/cli/src/commands/hiring.ts:59
- listApplications | reads up to 200 applications, optional stage filter, console.table | {stage?} -> void | [reads,pure-compute] | apps/cli/src/commands/hiring.ts:5
- addStudent | validates names, calls enrolment.createStudent (student + optional guardian link) | {firstName,lastName,...,guardian*} -> void | [creates,mutates,external-effect] | apps/cli/src/commands/students.ts:87
- listStudents | enrolment.searchStudents then client-side subject filter, console.table | {status?,yearLevel?,subject?,limit?} -> void | [reads,pure-compute] | apps/cli/src/commands/students.ts:10
- ingestCurriculum | reads doc file, builds embeddings+LLM+storage adapters, ingestDocument: stores file, chunks, embeds, writes document+chunks | {filePath,title,...} -> void | [reads(file),external-effect(embeddings+LLM),creates(file),creates(db)] [batch][async-job] | apps/cli/src/commands/ingest-curriculum.ts:18
- generateInvoices | --dry-run counts via raw SQL; real run calls billing.generateTermInvoices creating term invoices | {term,...,dryRun} -> void | [reads,creates,external-effect] [batch] | apps/cli/src/commands/invoices.ts:104
- listOverdueInvoices | raw SQL over invoices_active where overdue, computes days overdue, console.table | Client -> void | [reads,pure-compute] | apps/cli/src/commands/invoices.ts:207
- importProspectsFromCsv | reads CSV, hand-parses rows, calls outreach.bulkImportProspects; prints imported/skipped/failed | (slice,csvFile) -> void | [reads(file),pure-compute,creates,external-effect] [batch] | apps/cli/src/commands/outreach.ts:42
- seed | idempotent dev-data seeding (many upserts), guards against prod unless --force | (Client,{force?}) -> void | [reads,creates,mutates,external-effect] [batch] | apps/cli/src/commands/seed.ts:15
- route:leads.createLead | POST /api/admin/leads — thin dispatch to leads.createLead, 201, default source=manual | JSON body -> Result | [creates] | apps/web/src/server/api/leads.ts:104
- route:leads.convertLead | POST /:id/convert — dispatch leads.convertLead; 409 ALREADY_CONVERTED | params+json -> Result | [mutates,external-effect] | apps/web/src/server/api/leads.ts:143
- route:leads.deleteLead | DELETE /:id — dispatch leads.deleteLead, maps void->null | params -> null | [deletes] | apps/web/src/server/api/leads.ts:182
- route:leads.autoAssign | POST /:id/auto-assign — reads lead subject via leads.getLead, hands to enrolment.autoAssignTutor | params -> Result | [reads,mutates] | apps/web/src/server/api/leads.ts:315
- route:leads.assign | POST /:id/assign — auth-table role check + leads.assignLead + targeted admin notification | params+{userId} -> Result | [reads,mutates,creates] | apps/web/src/server/api/leads.ts:363
- route:leads.list | GET /api/admin/leads — leads.listLeads + session-scoped assignedTo filter | query -> Result | [reads,reads(session),pure-compute] | apps/web/src/server/api/leads.ts:222
- route:ai.ask | POST /api/ai/ask — per-user sliding rate limit, then curriculum.askCurriculum (RAG retrieve + LLM answer w/ citations) | {question,subject?,yearLevel?} -> {answer,citations} | [reads(rate-limit),reads(chunks),external-effect(LLM),pure-compute] [async-job] | apps/web/src/server/api/ai.ts:38
- route:adminSecrets.list | GET /admin/secrets — lists secret_refs (never plaintext) | none -> {refs} | [reads] | apps/web/src/server/api/admin-secrets.ts:121
- route:adminSecrets.rotate | POST /admin/secrets/rotate — validates new master key, optional approval-gate (202), atomically re-encrypts every secret_refs row | {newMasterKey} -> {rotated,message} | [reads,reads(env),mutates(bulk),external-effect] [batch] | apps/web/src/server/api/admin-secrets.ts:157
- route:adminSecrets.delete | DELETE /admin/secrets/:ref — deletes a secret_ref by ref (no cascade) | params(ref) -> Result | [deletes] | apps/web/src/server/api/admin-secrets.ts:259
- proj:sessionCancelledProjection | on SESSION_CANCELLED: per studentId reads student/parent/user, enqueues parent cancellation email | SessionCancelled -> void | [reads,external-effect] [async-job] | apps/worker/src/projections/worker.ts:174
- proj:enrolmentConvertedProjection | on ENROLMENT_CONVERTED: reads parent+student, enqueues welcome email | EnrolmentConverted -> void | [reads,external-effect] | apps/worker/src/projections/worker.ts:239
- proj:invoiceIssuedProjection | on INVOICE_ISSUED: reads parent contact, enqueues invoice email with formatted total | InvoiceIssued -> void | [reads,pure-compute,external-effect] | apps/worker/src/projections/worker.ts:405
- proj:invoiceOverdueProjection | on INVOICE_OVERDUE (only if daysPastDue<=1): reads parent/invoice, enqueues overdue reminder | InvoiceOverdue -> void | [reads,pure-compute,external-effect] | apps/worker/src/projections/worker.ts:467
- proj:leadConvertedProjection | on LEAD_CONVERTED: reads lead, enqueues admin conversion notice + parent welcome email | LeadConverted -> void | [reads,external-effect] | apps/worker/src/projections/worker.ts:3120
- disp:xeroPushInvoiceDispatcher | outbox "xero.push-invoice": reads invoice+student+parent, calls accountingSync.createInvoice on external provider; throws to retry | {invoiceId,...} -> void | [reads,external-effect] [async-job] | apps/worker/src/projections/worker.ts:1744
- secretEffects.rotateMasterKey | re-encrypts all secret_refs current->new key (crash-recovery re-apply) | newMasterKeyMaterial -> void | [reads,mutates(bulk)] [batch] | apps/worker/src/secretEffects.ts:30
- secretEffects.deleteRef | parses ref id, deletes matching secret_refs row | ref -> void | [deletes] | apps/worker/src/secretEffects.ts:48
- secretEffects.refExists | parses ref id, SELECT exists on secret_refs | ref -> boolean | [reads] | apps/worker/src/secretEffects.ts:54

### normalize — CLI commands + normalize-tools MCP adapters

- analyze.health | runs health passes (file counts, complexity, large-file warnings) | (target?,root?,exclude[],only[],limit?) -> AnalyzeReport | [reads,pure-compute] | crates/normalize/src/service/analyze.rs:187
- analyze.security | heuristic pattern scan over indexed files for secrets/unsafe patterns | (target?,root?) -> SecurityReport | [reads,pure-compute] | crates/normalize/src/service/analyze.rs:275
- grep | regex text search across filtered files via in-process engine | (pattern,path?,root?,limit?,...) -> GrepReport | [reads,pure-compute] | crates/normalize/src/service/mod.rs:296
- translate | reads source/stdin, parses to IR, emits target language, writes output file or stdout | (input,to,from?,output?) -> TranslateReport | [reads,pure-compute,creates] | crates/normalize/src/service/mod.rs:672
- init | scaffolds project: creates .normalize/ + config.toml, optional index build; dry_run previews | (index,setup,dry_run) -> InitReport | [reads,creates] [config] | crates/normalize/src/service/mod.rs:400
- update | queries GitHub releases API, downloads matching binary, self-replaces the running executable | () -> UpdateReport | [reads,external-effect,mutates] | crates/normalize/src/service/mod.rs:532
- sync | copies project tree(s) incrementally to dest, rewrites index paths; --all discovers roots; dry_run previews | (dest?,all,root?,dry_run,...) -> SyncReport | [reads,creates,mutates] [batch] | crates/normalize/src/service/mod.rs:883
- daemon.run | runs file-watching index daemon in foreground until exit | () -> DaemonRunReport | [reads,creates,mutates,external-effect] [daemon] | crates/normalize/src/service/daemon.rs:291
- edit.replace | replaces a resolved symbol's source in file, records a shadow-git commit; --each fans across files; dry_run previews | (target,content,dry_run,...,each) -> EditResult | [reads,mutates,external-effect] | crates/normalize/src/service/edit.rs:1040
- facts.rebuild | tree-sitter parse, extract symbols/calls/imports, write facts index DB (incremental unless --full) | (include[],root?,...,full,strict,dry_run) -> RebuildReport | [reads,creates,mutates,external-effect] [batch] | crates/normalize/src/service/facts.rs:952
- generate.cli_snapshot | spawns target CLI binary as subprocess to capture help/output, generates snapshot-test source | (binary,output?,name?) -> GenerateReport | [reads,external-effect,creates] | crates/normalize/src/service/generate.rs:156
- grammars.install | downloads tree-sitter grammar tarball from GitHub, extracts into config dir | (version?,force,dry_run) -> GrammarInstallReport | [reads,external-effect,creates] | crates/normalize/src/service/grammars.rs:99
- history.prune | prunes shadow-git edit history keeping last N commits (deletes older shadow commits) | (keep,root?) -> HistoryPruneReport | [reads,deletes,external-effect] | crates/normalize/src/service/history.rs:173
- syntax.query | runs tree-sitter S-expr or ast-grep pattern query, returns matches with optional context | (pattern,path?,show_source,...) -> Vec<MatchResult> | [reads,pure-compute] | crates/normalize/src/service/syntax.rs:122
- view.view | resolves target, builds skeleton/signature tree with configurable depth/docs/deps; may query daemon | (target?,root?,depth?,...) -> ViewReport | [reads,pure-compute] | crates/normalize/src/service/view.rs:171
- context.migrate | walks tree for legacy context files; --apply creates .normalize/context/, writes new, removes old | (root?,apply) -> MigrateReport | [reads,creates,deletes] | crates/normalize/src/service/context.rs:347
- tools.lint.run | runs detected linters/formatters/type-checkers as subprocesses; --fix mutates files; --repos-dir fans across repos | (target?,fix,dry_run,...) -> LintRunReport | [reads,external-effect,mutates] [batch] | crates/normalize/src/service/tools.rs:91
- tools.test.run | runs native test runner subprocess (auto-detected/specified); --repos-dir fans | (runner?,args[],...) -> TestRunReport | [reads,external-effect] | crates/normalize/src/service/tools.rs:154
- tool:clippy | MCP adapter: run() spawns cargo clippy --message-format=json; fix() runs clippy --fix rewriting files | (paths[],root) -> ToolResult | [reads,external-effect,mutates] [agentic/LLM-tool] | crates/normalize-tools/src/adapters/clippy.rs:105
- tool:eslint | MCP adapter: run() spawns eslint JSON linter; fix() adds --fix | (paths[],root) -> ToolResult | [reads,external-effect,mutates] [agentic/LLM-tool] | crates/normalize-tools/src/adapters/eslint.rs:100
- tool:prettier | MCP adapter (formatter): run() checks; fix() adds --write | (paths[],root) -> ToolResult | [reads,external-effect,mutates] [agentic/LLM-tool] | crates/normalize-tools/src/adapters/prettier.rs:93
- tool:rustfmt | MCP adapter (formatter): run() checks via subprocess; fix() writes formatted files | (paths[],root) -> ToolResult | [reads,external-effect,mutates] [agentic/LLM-tool] | crates/normalize-tools/src/adapters/rustfmt.rs:88
- tool:ruff | MCP adapter (linter): run() spawns ruff check; fix() adds --fix | (paths[],root) -> ToolResult | [reads,external-effect,mutates] [agentic/LLM-tool] | crates/normalize-tools/src/adapters/ruff.rs:106
- tool:mypy | MCP adapter (type-checker): run() spawns mypy subprocess parsing diagnostics; no auto-fix | (paths[],root) -> ToolResult | [reads,external-effect] [agentic/LLM-tool] | crates/normalize-tools/src/adapters/mypy.rs:90
- tool:CustomTool | user-configured Tool: run() executes a custom command subprocess; optional separate fix command | (paths[],root) -> ToolResult | [reads,external-effect,mutates] [agentic/LLM-tool] | crates/normalize-tools/src/custom.rs:236

### curilo-for-parents — Supabase edge functions

- run-golden-prompts | [LLM] runs active golden_prompts through Gemini, scores vs expected ranges, records pass/fail per run | {Bearer admin} -> {run_id,total,passed,failed,failures[]} | [reads,creates,external-effect] | supabase/functions/run-golden-prompts/index.ts:181
- assign-teacher-role | admin-only: inserts a 'teacher' user_roles row (idempotent on dup) | {targetUserId}+Bearer(admin) -> {success} | [reads,creates] | supabase/functions/assign-teacher-role/index.ts:5
- award-progress | on lesson completion: derives score, logs event, increments skill thread, invalidates dashboard caches | {sessionId,skillFocus}+Bearer -> {success} | [reads,creates,mutates,deletes] | supabase/functions/award-progress/index.ts:12
- check-registration-allowed | checks whether a normalised email is in approved_emails (fail-closed) | {email} -> {allowed} | [reads] | supabase/functions/check-registration-allowed/index.ts:5
- compute-score-distribution | admin: aggregates quality/criterion events over a window into mean/stddev/percentile rows | {windowDays}+Bearer(admin) -> {success,data[]} | [reads,creates] | supabase/functions/compute-score-distribution/index.ts:26
- compute-skill-competency | Elo/Glicko rating engine: incremental/snapshot recompute from events, caches, logs snapshots + velocity alerts | {skill?}+Bearer -> {success,data} | [reads,creates,mutates] | supabase/functions/compute-skill-competency/index.ts:216
- demo-feedback | [LLM] public no-auth demo: rate-limited, scores a writing sample on a 7-criteria rubric via Gemini | {writingSample,yearLevel,prompt} -> rubric JSON | [external-effect] | supabase/functions/demo-feedback/index.ts:28
- generate-blog-image | [LLM] admin: generates a blog image from a prompt via Gemini image model | {prompt}+Bearer(admin) -> {imageUrl} | [reads,external-effect] | supabase/functions/generate-blog-image/index.ts:9
- generate-grammar-exercises | [LLM] serves a random banked exercise or, on miss, generates via Gemini and stores it (fire-and-forget) | {skill_focus,writing_type,year_band}+Bearer -> {steps} | [reads,creates,external-effect] | supabase/functions/generate-grammar-exercises/index.ts:89
- generate-learning-plan | [LLM] onboarding: Gemini picks 2-3 skill threads, wipes existing plans, inserts new learning_plans rows | {preferences,userName}+Bearer -> {threads,welcome_message} | [reads,creates,deletes,external-effect] | supabase/functions/generate-learning-plan/index.ts:17
- generate-teaching-resource | [LLM] teacher: multi-step Gemini pipeline (plan->blocks->teacher blocks->validate), inserts teaching_resources + revision | {ResourceInput}+Bearer(teacher/admin) -> {resource,validation,progress} | [reads,creates,external-effect] | supabase/functions/generate-teaching-resource/index.ts:289
- grant-parental-consent | token-authed: lookup mode returns status; grant mode flips status to granted and nulls token | {token,action} -> {success/childName/consentStatus} | [reads,mutates] | supabase/functions/grant-parental-consent/index.ts:6
- invite-teacher | teacher: validates class ownership + target, inserts a class_teachers collaborator row | {email,class_id}+Bearer(teacher) -> {success} | [reads,creates] | supabase/functions/invite-teacher/index.ts:4
- lesson-chat | [LLM][streaming] streams Gemini tutor reply via SSE while a parallel Gemini eval scores the turn, persists session/messages/events/phase | {context,...,userMessage}+Bearer -> SSE stream | [reads,creates,mutates,external-effect] | supabase/functions/lesson-chat/index.ts:196
- lookup-student-by-email | teacher: validates class ownership, finds student by email, inserts a class_members row | {email,class_id}+Bearer(teacher) -> {success} | [reads,creates] | supabase/functions/lookup-student-by-email/index.ts:4
- ocr-homework-photos | [LLM] downloads submission photos from storage, OCRs each via Gemini Vision, writes ocr_text back | {submission_id}+Bearer -> {text,pages} | [reads,mutates,external-effect] | supabase/functions/ocr-homework-photos/index.ts:10
- query | [LLM] Gemini tool-use loop answering NL questions grounded in DB, with server-side session history | {question,sessionId?,role?}+Bearer -> {ok,answer,sessionId,request_id} | [reads,creates,external-effect] | supabase/functions/query/index.ts:289
- recommend | [LLM] dashboard recommender: scores threads deterministically, calls Gemini for reason strings, caches, mutates/creates learning_plans | {mode,sessionId,threadId}+Bearer -> recommendation JSON | [reads,creates,mutates,external-effect] | supabase/functions/recommend/index.ts:128
- revise-teaching-resource-block | [LLM] teacher: regenerates one worksheet block via Gemini (intent-classified), validates, updates resource + logs revision | {resourceId,blockId,teacherRequest,version}+Bearer -> {resource,block,validation} | [reads,creates,mutates,external-effect] | supabase/functions/revise-teaching-resource-block/index.ts:60
- run-spot-check | [LLM] quiz engine: get_questions randomizes; submit_answers grades MC by key + open-ended via Gemini, logs skill_check events, invalidates cache | {action,...,answers[]}+Bearer -> {...,overall_score} | [reads,creates,deletes,external-effect] | supabase/functions/run-spot-check/index.ts:30
- send-auth-email | verifies a Supabase auth webhook signature, renders a React email template, sends via Resend | signed webhook payload -> {success,messageId} | [external-effect] | supabase/functions/send-auth-email/index.ts:19
- send-parental-consent | authed student: sets parent_email + status=pending, emails the consent link via Resend | {parentEmail}+Bearer -> {success} | [reads,mutates,external-effect] | supabase/functions/send-parental-consent/index.ts:15
- send-waitlist-invite | admin: per waitlist signup generates invite code, stores it, emails invite via Resend, stamps invite_sent_at | {signupIds[]}+Bearer(admin) -> {success,sent,failed,results[]} | [reads,mutates,external-effect] | supabase/functions/send-waitlist-invite/index.ts:21
- send-welcome-email | authed: renders welcome React email template, sends to caller's email via Resend | {userName,dashboardUrl}+Bearer -> {success,messageId} | [reads,external-effect] | supabase/functions/send-welcome-email/index.ts:10
- update-student-profile | [LLM] at session close: reads transcript + prior profile + ratings, Gemini writes updated profile, inserts new append-only version | {sessionId}+Bearer -> {success,version} | [reads,creates,external-effect] | supabase/functions/update-student-profile/index.ts:53
- writing-tutor | [LLM] multi-mode Gemini assessor: routes to ICAS/NAPLAN/free-write marking or tutor chat, pre-analysis, scored feedback; NAPLAN logs events | {isIcasTest|...,writingSample,...}+Bearer -> assessment/chat JSON | [reads,creates,external-effect] | supabase/functions/writing-tutor/index.ts:659

### interconnect / reincarnate / rescribe / myenv / claude-code-hub / chub-moderate

- ic:Recv | drain all messages pending since room's read cursor; optionally block until one arrives | {room,block} -> Messages{messages[]} | [reads,mutates(cursor),async-wait] [daemon] | interconnect/crates/interconnect-daemon/src/daemon.rs:216
- ic:Send | forward an intent payload to a room's live connector task for external delivery | {room,payload} -> Sent{ok} | [reads,external-effect] [daemon] | interconnect/crates/interconnect-daemon/src/daemon.rs:200
- ic:State | return a room snapshot (name, connector, count, cursor, last message) | {room} -> State{snapshot} | [reads] | interconnect/crates/interconnect-daemon/src/daemon.rs:192
- ic:List | list names of all configured rooms | {} -> Rooms{rooms[]} | [reads] | interconnect/crates/interconnect-daemon/src/daemon.rs:186
- ic:spawn_room | dispatch on connector kind, start connector task bridging a room to an external service | (&RoomConfig,Sender) -> RoomHandle | [reads,creates,external-effect] [daemon] | interconnect/crates/interconnect-daemon/src/room.rs:37
- re:Extract | load manifest, run frontend extractor to IR, run transform pipeline, print each module to stdout | (manifest_path,skip_passes[]) -> Result | [reads,pure-compute,external-effect(stdout)] | reincarnate/crates/reincarnate-cli/src/main.rs:595
- re:Emit | run full lift pipeline (extract->transform->structurize->emit), write target source + assets | (target/manifest,preset,...) -> Result | [reads,pure-compute,creates,mutates(registry)] | reincarnate/crates/reincarnate-cli/src/main.rs:728
- re:Add | register a project in on-disk registry keyed by name, deriving engine from manifest | (path?,name?,force) -> Result | [reads,mutates/creates,external-effect(write registry)] | reincarnate/crates/reincarnate-cli/src/main.rs:2427
- re:List | list all registered projects from registry, sorted, optional JSON | (sort,json) -> Result | [reads,external-effect(stdout)] | reincarnate/crates/reincarnate-cli/src/main.rs:2482
- rs:Convert | detect in/out formats, read+parse input document, transform, emit, write output file/stdout | (input,output?,from?,to?) -> Result | [reads,pure-compute,creates] | rescribe/crates/rescribe-cli/src/main.rs:696
- rs:Formats | print the static table of supported reader/writer formats | () -> () | [pure-compute,external-effect(stdout)] | rescribe/crates/rescribe-cli/src/main.rs:56
- my:Generate | generate per-tool config files from nursery.toml (check/diff/watch variants) | (manifest,check,diff) -> ExitCode | [reads,creates/mutates] [config] | myenv/crates/myenv-cli/src/commands/generate.rs:12
- my:Init | resolve a seed template + variables (prompting for missing), scaffold a new project directory | (name,seed,vars,raw,no_prompt) -> ExitCode | [reads,reads(stdin),creates] | myenv/crates/myenv-cli/src/commands/init.rs:9
- my:Tools Install | compute missing required deps vs detected package manager, prompt, shell out to install | (manifest,dry_run,dev,build) -> ExitCode | [reads,external-effect(probe+spawn),reads(stdin),mutates(system pkgs)] | myenv/crates/myenv-cli/src/commands/tools.rs:118
- my:Tools Lock | resolve every dep to per-ecosystem names via Repology HTTP API, write myenv.lock | (manifest) -> ExitCode | [reads,external-effect(HTTP),creates(lockfile)] | myenv/crates/myenv-cli/src/commands/tools.rs:274
- cch:GET /repos | return unique existing cwds harvested from discovered Claude Code sessions | GET /repos -> string[] | [reads(session files)] | claude-code-hub/src/server.ts:79
- cch:POST /agents | spawn a new Claude Code agent in a cwd with a prompt + capability preset | POST {cwd,prompt,preset} -> agent | [creates,external-effect(launch agentic run)] [agentic/LLM][async-job] | claude-code-hub/src/server.ts:92
- cch:POST /agents/:id/message | inject a follow-up prompt into a running agent's session | POST {prompt} -> {ok} | [reads,mutates(status),external-effect(drives LLM turn)] [agentic/LLM] | claude-code-hub/src/server.ts:106
- cch:POST /hooks/:name | webhook: look up saved trigger, interpolate payload into prompt template, spawn agent | POST {arbitrary json} -> {ok,agentId} | [reads,pure-compute,creates,external-effect] [agentic/LLM][async-job] | claude-code-hub/src/server.ts:149
- cch:POST /triggers | persist a named webhook trigger (name,cwd,prompt,preset) | POST {...} -> {ok} | [creates] [config] | claude-code-hub/src/server.ts:127
- cch:hub_read_agent | MCP tool: read another agent's status/summary/messages after capability check | {target_id,detail} -> text(JSON) | [reads(caps),reads(target msgs)] [auth/session] | claude-code-hub/src/hub-mcp.ts:40
- cch:hub_message_agent | MCP tool: send a message to another agent and await its response, gated by canMessage | {target_id,message,timeout_ms} -> text | [reads(caps),external-effect(drives target LLM),mutates(target session)] [agentic/LLM][auth/session] | claude-code-hub/src/hub-mcp.ts:75
- cch:hub_spawn_agent | MCP tool: spawn a new agent, gated by canSpawn | {cwd,prompt,preset} -> text(id) | [reads(cap),creates,external-effect(launch agentic run)] [agentic/LLM][async-job][auth/session] | claude-code-hub/src/hub-mcp.ts:105
- chub:stage0-index | walk 4 source sqlite DBs read-only, extract card fields, build index.sqlite + FTS5 (drops/recreates each run) | (env) -> index.sqlite | [reads(4 external DBs),creates/overwrites] [batch] | chub-moderate/src/stage0-index.ts:1
- chub:stage1-prefilter | classify each indexed card into bucket A/B via pure tag rules, write buckets.sqlite | (env) -> buckets.sqlite | [reads,pure-compute,creates/overwrites] [batch] | chub-moderate/src/stage1-prefilter.ts:51
- chub:stage2-classify | per bucket row call LLM verdict once, write verdict row; resumable (skips judged) | (--limit) -> verdicts.sqlite | [reads,external-effect(LLM per card),creates/appends] [agentic/LLM][batch] | chub-moderate/src/stage2-classify.ts:36
- chub:stage3-rank | join verdicts+buckets+index, order by p_flag, materialize review_queue.sqlite | (--limit) -> review_queue.sqlite | [reads(3 DBs),pure-compute,creates/overwrites] [batch] | chub-moderate/src/stage3-rank.ts:38
- chub:refine | join reviews+verdicts+index into a markdown report (confusion table, overturns, agreement) | (env) -> reports/refine.md | [reads,pure-compute,creates(report)] [batch] | chub-moderate/src/refine.ts:1

---

## STEP 2 — INDUCED STRUCTURE

### The premise the data forces us to abandon

The task asked whether "one kind per operation" is viable. It is not. With ~77% of ops
carrying 2+ effect atoms and a real handler exhibiting all four write-atoms at once
(`award-progress`: reads+creates+mutates+deletes), an operation is **a point in an
effect-vector space**, not a member of one mutually-exclusive bucket. Below: first the
DIMENSIONS the corpus varies along (the honest primary result), then the recurring GESTALTS
(frequent points in that space — descriptive attractors, explicitly NOT a partition).

### The effect atoms are the wrong resolution — `external-effect` shatters

The harvest vocabulary's `external-effect` atom lumps together behaviors the code treats as
categorically different. Reading bodies, it splits into at least five kinds that recur
independently:

1. **deferred domain-event / outbox enqueue** — `eventBus.publish`, `outbox.enqueue`. The
   effect is handed to a durable queue and happens later; idempotent, retryable. This is the
   single most common "external" effect in the consumer app (nearly every state transition emits
   one) and it is invisible to any request/response or verb scheme — there is no slot for
   "announces that a thing happened."
2. **synchronous external I/O** — payment gateway charge, Xero/accounting push, Repology
   HTTP, GitHub releases API. Blocks on a third party; can fail mid-op.
3. **model invocation (LLM)** — Gemini / `generateObject`. Nondeterministic generation.
   ~14/26 curilo fns; also the consumer app (draftMarkingFeedback, generateTriggerFromNL,
   extractFromText, draftOutreach), chub stage2, all cch agentic ops.
4. **subprocess / filesystem** — spawn a linter/formatter/test runner, write files, shadow-git
   commit, self-replace binary. All of normalize's write ops; myenv install; reincarnate/rescribe emit.
5. **email / SMS send** — Resend, Twilio, mail.send (when *not* via outbox).
6. **agent orchestration** — spawn/drive another autonomous agentic run (cch).

Any taxonomy operating at the `external-effect` granularity throws away the corpus's most
important distinctions. So the first real finding: **the effect vocabulary needs refining
before it can classify — the atoms as given under-resolve.**

### Dimensions the corpus genuinely varies along (primary result)

Five roughly-orthogonal axes account for the observed variation. An op is a value on each:

- **D1 — Persistence footprint** {none · read · create · mutate · delete} (a *set*, multi-valued).
  Read-then-write is the dominant compound (guard/load then transition). Pure `none` is rare
  (previewImport, assemblePayslip, syntax.query).
- **D2 — Boundary reach** {none · deferred-event/outbox · sync-external-IO · model-invocation ·
  subprocess/fs · agent-spawn} (also multi-valued — e.g. handleGoCardlessWebhook is
  sync-external + deferred-event). This is the refined `external-effect` above.
- **D3 — Generativity** {deterministic · model-generated}. Strong axis: it changes whether the
  output is reproducible. ~20% of the corpus is model-generated.
- **D4 — Cardinality / fan-out** {single-subject · batch/per-row · whole-corpus-rebuild}.
  Pervasive: bulkSendInvoiceReminders, batchScheduleLessons, expireStaleTrials, broadcastMessage,
  sendDueSurveys, confirmImport, migrate, seed, facts.rebuild, stage0-index.
- **D5 — Invocation / lifetime** {request-response · scheduled/cron · event-projection ·
  long-running daemon · streaming · pipeline-stage}. The SAME "do" (enqueue a parent email) is
  reached three ways: direct use-case (composeMessage), cron sweep (sendDueSurveys), and event
  projection (invoiceIssuedProjection). Lifetime is orthogonal to what-it-does.

Confidence: **high** that multi-effect dominates and single-kind fails; **high** that D1/D2/D4/D5
are real and independent; **moderate** on D3 as separate vs. a value of D2's model-invocation.
The data supports **5 dimensions**, not N categories.

### Recurring gestalts (frequent points in the space — NOT a partition)

These are the shapes that recur across apps. They overlap (an op can be two — e.g.
run-spot-check is both LLM-generative AND a batch quiz loop), which is itself evidence for the
vector model. Cited, with rough counts:

- **G1 · Read-model query / view** (~28) — read state, compute a projection, return; no writes,
  no reach. Tight cluster. `getDashboardKpis`, `getGrowthForecast`, `getPnl`, `reconcileWithXero`,
  `calculateTutorPay`, `findReplacementTutor`, `listApplications`, `getTriggerRuns`, `analyze.health`,
  `view.view`, `grep`, `ic:State`, `ic:List`, `route:adminSecrets.list`, `check-registration-allowed`.
- **G2 · Guarded state transition + announce** (~22) — load one aggregate, check invariant, flip a
  field/status, emit a deferred domain event. The the consumer app spine. Very tight. `approveRequest`,
  `voidInvoice`, `convertLead`, `cancelLesson`, `completeLesson`, `approveAbsence`, `advanceApplicant`,
  `recordOutcome`, `grant-parental-consent`, `route:leads.convertLead`.
- **G3 · Create-and-announce** (~10) — insert a new aggregate, emit event / notification.
  `enqueueApproval`, `createSession`, `assignShift`, `createClass`, `createTrigger`, `invite-teacher`,
  `cch:POST /triggers`, `re:Add`, `assign-teacher-role`.
- **G4 · External-settlement** (~10) — call an external money/accounting/comms system and record
  the result; idempotency-keyed. `chargeMandate`, `createCheckoutSession`, `issueRefund`,
  `chargeInstalment`, `reconcileGatewaySettlement`, `handleGoCardlessWebhook`, `xeroPushInvoiceDispatcher`,
  `recordExpense`.
- **G5 · Notification fan-out** (~14) — resolve a recipient set, enqueue messages (often batch,
  deferred). `broadcastMessage`, `composeMessage`, `sendOverdueReminders`, `sendDueSurveys`,
  `bulkSendInvoiceReminders`, `send-*-email`, all five worker projections.
- **G6 · Batch orchestration / import loop** (~14) — iterate many subjects, dispatch sub-use-cases,
  tally created/updated/skipped/errors. `confirmImport`, `batchScheduleLessons`, `generateSessionsForClass`,
  `expireStaleTrials`, `seed`, `generateInvoices`, `importProspectsFromCsv`, `run-payroll`,
  `run-golden-prompts`, `migrate`.
- **G7 · Model-generative op** (~20) — call an LLM to produce content/decision, usually persist it.
  `draftMarkingFeedback`, `draftOutreach`, `extractFromText`, `generateTriggerFromNL`, `generate-*`,
  `writing-tutor`, `query`, `recommend`, `update-student-profile`, `ocr-homework-photos`, `route:ai.ask`.
- **G8 · Agentic orchestration** (~8) — spawn/drive autonomous agents, or MCP tools that call models
  with tools. `cch:POST /agents`, `cch:POST /hooks`, `cch:hub_spawn/message/read`, normalize MCP adapters.
- **G9 · Tooling / codemod / build** (~14) — run subprocess tools, rewrite files, snapshot into
  shadow-git. `edit.replace`, `tools.lint.run`, `tools.test.run`, `clippy/eslint/prettier/rustfmt/ruff/mypy`,
  `facts.rebuild`, `generate.cli_snapshot`, `grammars.install`, `sync`, `re:Emit`, `rs:Convert`.
- **G10 · Long-running / streaming / daemon / connector** (~7) — hold open, watch, bridge, stream.
  `daemon.run`, `ic:Recv`, `ic:Send`, `ic:spawn_room`, `lesson-chat` (SSE streaming).
- **G11 · Config / scaffold** (~6) — write config or scaffold a project. `init`, `my:Generate`,
  `my:Init`, `doctor`, `cch:POST /triggers`.
- **G12 · Pipeline stage** (~5) — read one materialized store, transform (rules or LLM), write the
  next store; resumable, batch. `chub:stage0-3`, `chub:refine`.

The data supports roughly **10–12 gestalts** but they are *not* disjoint — ~15% of ops sit
squarely in two (run-spot-check ∈ G6∩G7; ingestCurriculum ∈ G6∩G9; lesson-chat ∈ G7∩G10). This
overlap is the whole point: gestalts are attractors in the D1–D5 vector space, not a classification.

### Stubborn boundary cases (quoted)

- `sendProgressReportToParent` — "**despite the name, only loads the report and stamps it sent (no
  email/outbox)**." Name promises external dispatch; behavior is read+mutate. Refutes name-based classing.
- `reassignMarkingJob` — "**outbox/eventBus are in deps but never invoked**." Declared capability ≠
  exercised effect; signature-based classing over-counts.
- `route:ai.ask` — "mutation-shaped, POST" but is a read+LLM RAG op. Protocol verb disagrees with behavior.
- `extractFromText` / `generateTriggerFromNL` — `[external-effect]` **only**: call a model, touch no
  persistent state at all. Is "external-effect" one thing? No — model-invocation is categorically
  unlike a gateway call; these ops prove the atom must split.
- `award-progress` — reads+creates+mutates+deletes in one handler: the entire write quartet at once.
- `ic:Recv` — a "read" that "**drain advances [the cursor]**" (so also mutates) and async-waits. A
  read that is not read-only.
- `handleInboundTurn` / `lesson-chat` — five effects each (reads+creates+mutates+model+streaming).

### What recurs that a naive scheme would miss

- **Deferred domain-event emission (outbox)** as a first-class, dominant effect — no verb/CRUD slot for it.
- **Model invocation** as its own effect kind (nondeterministic; ~20% of corpus).
- **Invocation mode is orthogonal to behavior**: the same enqueue-email "do" arrives as direct call,
  cron sweep, and event projection.
- **Batch/fan-out** is pervasive, not an edge case.
- **Long-running / daemon / streaming / pipeline-stage** lifetimes don't fit request-response at all.
- **Idempotency-keying** (double-charge guard, per-invoice-per-day, gatewayReference, skip-already-judged)
  and **capability/role gating** (cch caps, admin-only edge fns) recur as first-class properties.
- **dry-run / --check preview mode** recurs across normalize, myenv, CLI — an op that deliberately
  performs none of its effects.
- **Name and signature both lie** about effects (the two mismatch cases) — only the body is ground truth.

### Bottom line

The corpus refutes "an operation has a kind." Operations are **effect vectors over ~5 dimensions**
(persistence footprint, boundary reach, generativity, cardinality, invocation/lifetime), with the raw
`external-effect` atom needing to split into at least {deferred-event, sync-IO, model, subprocess/fs,
agent-spawn}. ~10–12 recurring **gestalts** are useful named attractors in that space but overlap and do
not partition. Confidence high on the vector verdict and on D1/D2/D4/D5; moderate on the exact gestalt count.
