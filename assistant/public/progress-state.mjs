// Progress events describe server stages, never an estimated completion percentage.
export const progressStages = {
  sending: { label: 'Sending your question…', detail: 'Connecting to the service on this Mac.' },
  refreshing: { label: 'Checking data updates…', detail: 'Checking the source tables and preparing the current data catalog.' },
  interpreting: { label: 'Understanding your question…', detail: 'The local model is identifying what you want to learn from the selected data.' },
  checking: { label: 'Checking the selected data…', detail: 'Validating the requested scope and available records.' },
  calculating: { label: 'Calculating the results…', detail: 'Using the recorded statistics to calculate the answer.' },
  querying: { label: 'Reading the relevant records…', detail: 'Running a read-only query within your selected scope.' },
  reviewing: { label: 'Reviewing the query results…', detail: 'The local model is checking whether the retrieved records answer your question.' },
  composing: { label: 'Preparing the response…', detail: 'Putting the explanation and its query evidence on the page.' },
};

/** Reads either the existing JSON contract or opt-in, newline-delimited events. */
export async function readChatResponse(response, onProgress = () => {}) {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }
  if (!response.ok || !response.body) throw new Error('The progress connection could not be opened.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = ''; let bytes = 0; let terminal;
  function consume(line) {
    if (!line.trim()) return;
    if (terminal) throw new Error('The service sent data after completing the answer.');
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('The response was interrupted. Please try the question again.'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('The service returned an unreadable progress update.');
    if (event.type === 'progress') {
      if (typeof event.stage !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.stage)) throw new Error('The service returned an unreadable progress update.');
      // A newer server may add a stage while this page is already open.
      if (Object.hasOwn(progressStages, event.stage)) onProgress(event.stage);
    } else if (event.type === 'result' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
      terminal = event;
    } else if (event.type === 'error' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      && typeof event.data.error === 'string' && event.data.error.trim()) {
      terminal = event;
    } else throw new Error('The service returned an unreadable progress update.');
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('The response exceeded the display limit. Narrow the selection and try again.');
      buffered += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        consume(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
      }
    }
    buffered += decoder.decode();
    consume(buffered);
    if (!terminal) throw new Error('The connection ended before an answer arrived. Please try again.');
    if (terminal.type === 'error') throw new Error(terminal.data?.error || 'The local assistant could not complete this request.');
    return terminal.data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
