/**
 * Pure logic for the Agent Chat quick-reply buttons (#1663).
 *
 * When an agent run pauses on Claude's `AskUserQuestion` tool, the runtime posts
 * the terminal chat message with a structured `io.aee.ask-question` payload
 * *alongside* the human-readable Markdown body. The Admin Console renders that
 * payload as clickable option controls (`AskQuestionCard`); clicking one sends
 * the option's **label** as the user's reply plus a structured
 * `io.aee.ask-answer` identifier so the choice reads naturally in the transcript
 * and is unambiguous (AC2 / D2).
 *
 * All non-React decisions live here (dependency-free) so they land in the
 * `admin-console-src` CI job and stay unit-tested; `Message.jsx` /
 * `ChatPanel.jsx` are thin renderers over these (the #651 convention).
 *
 * MVP is single-choice (D1): the runtime already excludes `multiSelect`
 * questions from the interactive payload, so a payload that reaches here is
 * always single-select. We still defend against a malformed payload by
 * normalising it and dropping anything unusable.
 */

/** The message-content field the runtime attaches the structured question to. */
export const ASK_QUESTION_FIELD = 'io.aee.ask-question';
/** The message-content field a clicked answer carries back. */
export const ASK_ANSWER_FIELD = 'io.aee.ask-answer';

/**
 * Normalise a raw `io.aee.ask-question` payload into a safe render model, or
 * return null when it carries no usable question. Mirrors the runtime builder
 * (`_ask_user_question_payload`) defensively — never trusts shapes.
 *
 * @param {*} raw
 * @returns {{questions: Array<{questionId: string, header?: string, question?: string,
 *            options: Array<{optionId: string, label: string, description?: string}>}>}|null}
 */
export function normalizeAskQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const questions = Array.isArray(raw.questions) ? raw.questions : null;
  if (!questions || questions.length === 0) return null;

  const outQuestions = [];
  questions.forEach((q, qi) => {
    if (!q || typeof q !== 'object') return;
    const options = Array.isArray(q.options) ? q.options : null;
    if (!options) return;
    const outOptions = [];
    options.forEach((opt, oi) => {
      if (!opt || typeof opt !== 'object') return;
      const label = typeof opt.label === 'string' ? opt.label.trim() : '';
      if (!label) return;
      const entry = {
        optionId: typeof opt.optionId === 'string' && opt.optionId ? opt.optionId : `${qi}:${oi}`,
        label,
      };
      const desc = typeof opt.description === 'string' ? opt.description.trim() : '';
      if (desc) entry.description = desc;
      outOptions.push(entry);
    });
    if (outOptions.length === 0) return;
    const entry = {
      questionId: typeof q.questionId === 'string' && q.questionId ? q.questionId : `q${qi}`,
      options: outOptions,
    };
    const header = typeof q.header === 'string' ? q.header.trim() : '';
    if (header) entry.header = header;
    const text = typeof q.question === 'string' ? q.question.trim() : '';
    if (text) entry.question = text;
    outQuestions.push(entry);
  });

  if (outQuestions.length === 0) return null;
  return { questions: outQuestions };
}

/**
 * Build the `io.aee.ask-answer` content the clicked option sends back. The
 * answer references the question message's Matrix `event_id` so the transcript
 * can later mark that question answered (AC5 / AC6), and carries the structured
 * option identifier alongside the visible label (AC2 / D2).
 *
 * @param {string} questionEventId  the answered question message's event_id
 * @param {{questionId?: string, optionId: string, label: string}} option
 * @returns {{'io.aee.ask-answer': object}}
 */
export function buildAnswerContent(questionEventId, option) {
  const answer = {
    questionEventId,
    optionId: option.optionId,
    label: option.label,
  };
  if (option.questionId) answer.questionId = option.questionId;
  return { [ASK_ANSWER_FIELD]: answer };
}

/**
 * Index the transcript's answer messages by the question event_id they answer,
 * so a rendered question can look up whether (and how) it was answered.
 *
 * @param {Array<object>} messages
 * @returns {Map<string, object>} questionEventId → the answer record
 */
export function indexAskAnswers(messages) {
  const map = new Map();
  if (!Array.isArray(messages)) return map;
  for (const m of messages) {
    const a = m && m[ASK_ANSWER_FIELD];
    if (a && typeof a === 'object' && typeof a.questionEventId === 'string') {
      // First writer wins — the earliest answer to a question is authoritative.
      if (!map.has(a.questionEventId)) map.set(a.questionEventId, a);
    }
  }
  return map;
}

/**
 * Decide how a question message should render given its position in the
 * transcript. A question is **answerable** only while it is the newest message
 * (nothing came after it) and it has not already been answered — this one rule
 * covers every "stale" case the issue lists: an optimistic answer, a later agent
 * message, or a free-text reply all push a message after the question and make
 * its buttons inert (AC5 final-on-click, AC6 answered-on-reload, superseded
 * questions, and duplicate clicks). External `disabled` (sending / offline /
 * maintenance) also blocks submission.
 *
 * @param {object} args
 * @param {number} args.index            this message's index in `messages`
 * @param {number} args.messageCount     messages.length
 * @param {object|undefined} args.answer  the matching answer record, if any
 * @param {boolean} [args.disabled]      composer disabled (sending / offline)
 * @returns {{answerable: boolean, answeredOptionId: string|null, answeredLabel: string|null}}
 */
export function questionState({ index, messageCount, answer, disabled = false }) {
  const isLast = index === messageCount - 1;
  const answered = !!answer;
  return {
    answerable: isLast && !answered && !disabled,
    answeredOptionId: answered && typeof answer.optionId === 'string' ? answer.optionId : null,
    answeredLabel: answered && typeof answer.label === 'string' ? answer.label : null,
  };
}
