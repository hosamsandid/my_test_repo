// Matrix `/messages?dir=b` chunk → transcript messages (#2944).
//
// One mapping for every transcript: the live room (`ChatPanel` backfill and
// scroll-up) and a removed pool instance's archived chat render the same
// fields the same way. `dir=b` returns newest-first, so the result is reversed
// into chronological order. Redacted events (unsigned.redacted_because, left
// behind by Clear History) are dropped to avoid empty bubbles.
import { ASK_QUESTION_FIELD, ASK_ANSWER_FIELD } from './ask-question-view.js';
import { AUTHOR_FIELD } from './message-author.js';
import { STATUS_NOTE_FIELD } from './status-note.js';

export function chatMessagesFromEvents(chunk) {
  return (Array.isArray(chunk) ? chunk : [])
    .filter(ev => ev && ev.type === 'm.room.message' && !ev.unsigned?.redacted_because)
    .reverse()
    .map(ev => ({
      event_id: ev.event_id,
      sender:   ev.sender,
      ts:       ev.origin_server_ts,
      body:     ev.content?.body || '',
      msgtype:  ev.content?.msgtype || 'm.text',
      'io.aee.trigger':  ev.content?.['io.aee.trigger'] || null,
      'io.aee.loop-record':  ev.content?.['io.aee.loop-record'] || null,
      'io.aee.triggerFailure':  ev.content?.['io.aee.triggerFailure'] || null,
      [STATUS_NOTE_FIELD]:  ev.content?.[STATUS_NOTE_FIELD] || null,
      [ASK_QUESTION_FIELD]:  ev.content?.[ASK_QUESTION_FIELD] || null,
      [ASK_ANSWER_FIELD]:    ev.content?.[ASK_ANSWER_FIELD] || null,
      [AUTHOR_FIELD]:        ev.content?.[AUTHOR_FIELD] || null,
    }));
}
