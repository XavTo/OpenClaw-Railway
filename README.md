# OpenClaw Pro Stack on Railway

Deploy the official OpenClaw Control UI with private SearXNG search, headless Chromium and a persistent, OCR-enabled PDF library. Telegram, Discord and other supported channels can be added from OpenClaw when you need them. This template is intended for a single trusted owner.

## First launch

1. Deploy and open the public URL of the **OpenClaw** service.
2. Sign in with `RAILWAY_OWNER_PASSWORD` from the service variables. Select **Pair this browser**. OpenClaw issues its own single-use pairing link and saves a device credential in your browser. For later visits, use **Open chat** or bookmark the native chat.
3. Configure your model provider in OpenClaw Settings, or set a provider key in the OpenClaw Railway service and redeploy. A model key is needed for agent responses. The login page, browser pairing and PDF library can start without one.
4. Open **Browser** from a native conversation and navigate to a trusted public page, or ask the agent to search the web with SearXNG. Search makes real requests to upstream engines and they can rate-limit shared IP addresses.

## Read documents across chats

- Use **PDF library** in the setup page at `/railway/` to index documents. You can also attach a PDF in the native chat and ask OpenClaw to index it for later conversations when the attachment is available to that tool.
- Import up to 12 MB and 40 pages per PDF. Regular text extraction runs first. Pages with little embedded text are rendered and processed with local English/French Tesseract OCR. One import runs at a time. The searchable index retains text, filenames and page numbers. Download or keep your originals separately.
- In a fresh chat ask, “Search my PDF library for the warranty period and cite the file and page.” The tool does local keyword retrieval and sends selected excerpts to whichever chat model you configured. A cloud model receives those excerpts when used.
- Delete a document from **PDF library** to remove it from future library searches. OpenClaw chat transcripts or volume backups may still contain earlier copies of excerpts.

## Services and cost

| Service | Purpose |
| --- | --- |
| OpenClaw | Official version-pinned OpenClaw gateway, native Control UI, Chromium and on-demand PDF OCR. A single `/data` volume holds gateway configuration, pairings, sessions, workspaces and the SQLite PDF index. |
| SearXNG | Key-free search for OpenClaw over Railway private networking. Railway does not expose a public domain for this service. |

Chromium starts on demand. The default browser profile uses an explicit list of trusted public sites (including OpenClaw docs and GitHub). You can add a specific trusted hostname to `browser.ssrfPolicy.allowedHostnames` in OpenClaw Settings. SearXNG can still search the public web. OCR runs only during imports. Railway charges for real service usage, and your chosen LLM provider bills separately. Containerized Chromium uses the browser image's no-sandbox setting; keep the native app restricted to trusted operators. The template disables agent shell/elevated tools and browser JavaScript evaluation by default.

## Variables

| Variable | Service | Purpose |
| --- | --- | --- |
| `RAILWAY_OWNER_PASSWORD` | OpenClaw | Unique owner password for first pairing and PDF library operations. Use at least 16 characters. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | OpenClaw | Optional model credentials. A provider can also be configured in OpenClaw. |
| `OPENCLAW_INITIAL_MODEL` | OpenClaw | Optional initial model in `provider/model` form. Used when creating a new workspace configuration. |
| `OPENCLAW_PUBLIC_ORIGIN` | OpenClaw | Optional HTTPS origin override for a custom domain. Defaults to the Railway-generated service domain. |
| `SEARXNG_BASE_URL` | OpenClaw | Private SearXNG URL. Wired automatically by the template. |
| `SEARXNG_SECRET` | SearXNG | Deployment-specific internal secret. |

## Restore and updates

Back up the OpenClaw volume. Restarts reuse the existing configuration, paired device, chats and PDF index. Deploy the same source revision when restoring a backup. Review and test upstream version changes before updating the pinned image.

- [Official OpenClaw Control UI](https://docs.openclaw.ai/web/control-ui)
- [OpenClaw on Railway](https://docs.openclaw.ai/install/railway)
- [OpenClaw SearXNG provider](https://docs.openclaw.ai/tools/searxng-search)
