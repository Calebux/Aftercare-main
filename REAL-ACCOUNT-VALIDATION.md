# Validate the onboarding workflow with real accounts

Use the local app at **http://127.0.0.1:4310**. The new workflow lives in **Agents**, **Apps**,
and **Runs**. **Recoveries** is the separate GitHub/Linear/Slack recovery demo.

Start with a fictional customer in real apps. The initial run reads a HubSpot deal and creates
one Notion page. A second run can add a Slack notification. Jira and the other apps marked
**Planned** cannot be connected yet.

## 1. Connect HubSpot

1. Sign in to a HubSpot CRM account where you can create a test deal and a private app.
   Creating a private app requires Super Admin access.
2. In HubSpot, open **Development → Legacy apps → Create legacy app → Private**.
   Follow the [current private-app setup guide](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview)
   if your account shows different navigation.
3. Name the app **Aftercare validation**. In its scopes, enable `crm.objects.deals.read`.
4. Create the app. Open its **Auth** tab, choose **Show token → Copy**, and paste the token
   into **Aftercare → Apps → Connect HubSpot**.
5. Create a deal called **Aftercare Test A — Notion handoff** in HubSpot. Use a test amount
   and set its stage to Closed won. The current picker lists up to 50 deals and does not
   automatically enforce a Closed won stage, so check the selected deal yourself.

Aftercare only reads HubSpot in this workflow. You do not need CRM write permissions.
Paste tokens into the app's password fields; do not put them in chat, receipts, or this file.

## 2. Connect Notion

1. As a Notion Workspace Owner, open the
   [Notion developer portal](https://www.notion.so/profile/integrations). Under
   **Build → Internal connections**, create **Aftercare validation** for your workspace.
2. Enable **Read content** and **Insert content**. Copy the integration's token.
3. Create a regular Notion page named **Aftercare Test Onboarding**. Use a page, not a database.
4. Open the page's **••• → Connections → Add connections** menu and add the connection.
   Alternatively, grant the page through the connection's **Content access** tab.
5. Copy the parent page ID from its URL: the final 32 hexadecimal characters in the path,
   before any `?` query string. Hyphenated IDs are also accepted. Enter the ID, not the full URL.
6. In **Aftercare → Apps → Connect Notion**, paste the token and parent page ID.

[Notion's internal connection guide](https://developers.notion.com/guides/get-started/internal-connections)
explains tokens, capabilities, and page access. A Notion 404 can mean the page has not been
shared with the connection; it does not necessarily mean the page ID is wrong.

## 3. Validate a Notion-only run

1. In **Agents**, create an agent with an owner you recognize and a short onboarding brief.
2. Choose **Guided template** and turn off **Post an internal handoff in Slack**.
   This tests the real app connections without spending on AI planning.
3. Save, choose **Use connected apps**, and select **Aftercare Test A — Notion handoff**.
4. Click **Prepare plan**. Confirm the title, owner, checklist, and Notion destination.
5. Before approval, inspect Notion: no new onboarding page should exist.
6. Click **Approve & run in apps**. Open the result from the run details.
7. Independently confirm there is exactly one child page, that its summary and unchecked
   checklist match the preview, and that the HubSpot deal remains unchanged.
8. Confirm Aftercare shows **Verified**, and export the receipt.

This establishes real provider creation and read-back for that run. It does not establish
customer demand or general production reliability.

## 4. Add Slack and validate the complete handoff

1. Create a Slack app in your own workspace using the
   [Slack app setup guide](https://docs.slack.dev/app-management/quickstart-app-settings/).
   An existing app you created for Aftercare can be reused if it has the required scopes.
2. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `chat:write`
   - `channels:read`
   - `channels:history`
3. Install/reinstall the app into your workspace and copy the **Bot User OAuth Token**
   beginning with `xoxb-`.
4. Create a public test channel such as **#aftercare-validation** and invite the app to it.
   Copy the channel ID from the channel details. Private channels additionally need
   `groups:read` and `groups:history`.
5. In **Aftercare → Apps → Connect Slack**, enter the bot token and channel ID.
   This connection is separate from the existing recovery demo's Slack connection.
6. Create a fresh HubSpot deal named **Aftercare Test B — Slack handoff**. Edit the saved
   agent to enable the Slack handoff, then launch it against this deal in connected-app mode.
7. Inspect both previews, approve, then check Notion and Slack directly. Expect one new page
   and one message. The message should describe the prepared checklist, not claim that all
   onboarding tasks are completed. Export the receipt.

Use a fresh deal because Aftercare prevents another onboarding for the same deal and Notion
destination within a workspace, including when you change the agent's Slack setting.

## 5. Check the approval boundary

Use another fresh test deal for this check:

1. Prepare a plan, but do not approve it.
2. Rename that deal in HubSpot.
3. Try to approve the existing plan. Expect **Plan outdated** and no Notion/Slack writes.
4. Return to the agent and prepare a fresh plan for the changed deal. Review it again.

Also reload a completed run and confirm its receipt remains available. Trying to launch a
second onboarding for the same deal/destination should report the existing run rather than
create another page. To repeat a successful validation, create a fresh test deal.

## 6. Validate AI planning separately

Once the guided live run passes, edit the agent's planning setting to **Aftercare AI** if the
operator has configured it, or add an OpenRouter API key and model ID in **Settings** and select
**My model key**. Use a fresh test deal with a brief containing specific requested checklist
items. Check that the generated plan follows those instructions before approving it.

AI planning sends the deal, owner, and brief to the model provider and uses the selected
provider account's balance. **Sample mode always uses the guided template**, regardless
of the agent's AI setting; it is not a real-model acceptance test.

## If something fails

| What you see | What to check |
| --- | --- |
| HubSpot 401/403 | Private app token, its active status, and `crm.objects.deals.read` |
| Notion 404 | Correct parent page ID and explicit access for the connection |
| Notion 403 | Read/insert capabilities and access to the parent page |
| Slack `missing_scope` | Add the named bot scope, reinstall, and reconnect the token |
| Slack channel membership error | Invite the app to the exact channel whose ID you entered |
| No live deals | Connect HubSpot in the new Apps screen; confirm the account contains deals; the picker lists up to 50 |
| Connections disappear after restarting | Expected in this beta: tokens stay in server memory; reconnect the original tokens and destinations |
| Needs attention with a saved result link | Inspect the existing result first. **Verify & resume** checks it rather than creating it again |
| A write may have succeeded but its response was lost | Check the destination manually. There may already be a record; the beta will not retry an unknown create automatically |

Run history is separate from app credentials. Local history uses `.data`; hosted browser
sessions expire after 12 idle hours. Export receipts you want to retain. Restarting the
server during validation requires reconnecting credentials and is not necessary for the
initial live acceptance check.

## Record the evidence

Keep a local note for each test: date, run ID, test deal name, Notion result URL, optional Slack
result URL, expected result, observed result, and receipt filename. Do not record tokens.

| Check | Status | Run / receipt |
| --- | --- | --- |
| Guided Notion-only live run | Not run | — |
| Guided Notion + Slack live run | Not run | — |
| Source change blocks approval | Not run | — |
| Duplicate launch blocked | Not run | — |
| AI-prepared live run | Not run | — |

The automated suite already covers isolated provider responses and sample workflows.
This checklist records independent real-account validation; no passes are assumed.
