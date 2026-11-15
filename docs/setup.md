# Setup

## Requirements

- Node.js 22 or later.
- Python 3.11+ with the standard `sqlite3` module available as `python3`.
- A compatible Ollama runtime and an installed local model.
- Power BI Desktop on Windows to edit the PBIX report.

The verified development configuration used Qwen3.8:27b with Ollama 0.40.4 on an Apple M1 Max with 64 GB of unified memory. Its model files occupy about 18 GB and are not included. Other hardware and runtime combinations require their own checks.

## Start the model runtime

From the repository root:

```sh
npm run model
```

This starts an installed `ollama` executable on `127.0.0.1:11435`, with cloud features disabled. Set `FRMF_OLLAMA_BIN` if the executable is not on your path. The helper does not install Ollama or download weights.

In another terminal, check the models installed in that runtime:

```sh
OLLAMA_HOST=127.0.0.1:11435 ollama list
```

The command above uses macOS/Linux shell syntax. Provision a model compatible with your runtime and hardware before asking questions. The tested tag is `qwen3.8:27b`; its availability must be checked separately. If you install a different tag, set `FRMF_LOCAL_MODEL` to that exact name.

## Start the application

```sh
npm start
```

Open <http://127.0.0.1:8765/>. Select the seasons, competition and club before asking a question. The selected scope limits the records available to SQL. To include another period or competition, change the controls.

The startup command validates the supplied CSVs and builds `assistant/synthetic-snapshot.json`. This generated file is ignored by Git. Rebuild it explicitly with:

```sh
npm run snapshot
```

Copy the root `.env.example` to `.env` for local settings. The launch helpers load it without overriding existing shell variables.

| Variable | Purpose | Default |
| --- | --- | --- |
| `FRMF_LOCAL_MODEL` | Exact installed model tag | `qwen3.8:27b` |
| `FRMF_MODEL_BASE_URL` | Loopback Ollama endpoint | `http://127.0.0.1:11435` |
| `FRMF_OLLAMA_BIN` | Ollama executable for the model helper | `ollama` |
| `FRMF_SQLITE_PYTHON` | Python executable for query execution | `python3` |

Snapshot and test commands also require `python3` on your path. If an existing Ollama service uses port 11434, configure that endpoint instead of starting a second runtime.

The website's model-health message checks connectivity and the installed tag. A successful question additionally tests inference. Unavailable models and failed investigations produce a visible error or a marked partial result. Recorded handover responses took 79.55–107.45 seconds on the development machine.

## Tests

```sh
npm test
```

The command rebuilds the snapshot and runs JavaScript and Python tests. Application tests use simulated model responses and real bounded SQLite execution. They do not require model weights or establish general model accuracy.

The 29 October handover record reported 139 passing JavaScript tests, twelve passing Python tests and two skipped optional live tests. Three selected questions were also checked with the actual model against independent source calculations.

## Power BI

Open [`powerbi/report.pbix`](../powerbi/report.pbix) in Power BI Desktop. The delivered copy contains synthetic imported data and 15 pages: eleven visible analytical pages, three hidden supporting pages and an Assistant entry page.

The editable PBIX is the preserved 24 September download. Opening, rendering and refreshing it on federation hardware remain unverified. Refresh may require adapting the original source paths; the included CSVs and [schema](../data/synthetic/schema.json) provide the demonstration inputs. The PBIX is the report source, rather than a complete text-based rebuild project.

The Assistant page is an entry point to the separate website. Run the local service and open its address directly when needed. Automatic slicer transfer, embedded answering and direct DAX execution are not implemented.

## Data and operation

`data/synthetic/bi_model/` contains the effective V4 tables with the four V5 assist replacements already applied. Do not append another copy of those replacement rows. The [manifest](../data/synthetic/MANIFEST.json) records the cutoff date, row counts and file checksums.

The service validates source changes and pins one snapshot version for each investigation. Only the explicitly connected tables can be queried. Adding a CSV does not automatically establish safe joins or metric definitions.

The listener is local by default. Employee authentication, trusted network hosting and multi-user operation still require implementation and acceptance. A future federation integration should begin with one approved competition and season, then reconcile equivalent Power BI and assistant results.

`src/` and `sql/` preserve the initial import and export pipeline for an authorized source extract. That extract and its generated databases are not included. These scripts do not generate the synthetic CSV dataset or refresh the delivered PBIX.
