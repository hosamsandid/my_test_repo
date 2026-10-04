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
 * A `multiSelect: true` question (#2523, superseding the single-choice-only
 * MVP of D1) renders as toggleable options plus an explicit Submit; its answer
 * carries every selected option as `optionIds` / `labels` (plus a joined
 * `label` for display). Single-choice questions are unchanged. We still defend
 * against a malformed payload by normalising it and dropping anything unusable.
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
 *            multiSelect?: true,
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
    if (q.multiSelect === true) entry.multiSelect = true;
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
 * Toggle one option in a multi-select question's draft selection (#2523).
 * Returns a new array; the input is never mutated.
 *
 * @param {string[]} selectedIds
 * @param {string} optionId
 * @returns {string[]}
 */
export function toggleSelection(selectedIds, optionId) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  return ids.includes(optionId) ? ids.filter(id => id !== optionId) : [...ids, optionId];
}

/**
 * The answer entry for a submitted multi-select question (#2523): every
 * selected option in the card's own option order (not click order), or null
 * when nothing is selected — Submit stays disabled until at least one is.
 * `label` joins the labels for display and for the visible reply body; the
 * runtime rebuilds the resume prompt from `labels`, so a comma inside a label
 * stays unambiguous.
 *
 * @param {{questionId: string, options: Array<{optionId: string, label: string}>}} q
 * @param {string[]} selectedIds
 * @returns {{questionId: string, optionIds: string[], labels: string[], label: string}|null}
 */
export function buildSelectionAnswer(q, selectedIds) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const chosen = (q?.options || []).filter(o => ids.includes(o.optionId));
  if (chosen.length === 0) return null;
  const labels = chosen.map(o => o.label);
  return {
    questionId: q.questionId,
    optionIds: chosen.map(o => o.optionId),
    labels,
    label: labels.join(', '),
  };
}

/**
 * Build the `io.aee.ask-answer` content for a submitted single multi-select
 * question (#2523), correlated by `questionEventId` like every other answer.
 *
 * @param {string} questionEventId
 * @param {{questionId: string, optionIds: string[], labels: string[], label: string}} answer
 * @returns {{'io.aee.ask-answer': object}}
 */
export function buildSelectionAnswerContent(questionEventId, answer) {
  return {
    [ASK_ANSWER_FIELD]: {
      questionEventId,
      questionId: answer.questionId,
      optionIds: answer.optionIds,
      labels: answer.labels,
      label: answer.label,
    },
  };
}

/**
 * Whether an answer record chose `optionId` of `questionId` — covers a
 * single-choice answer (`optionId`), a multi-select answer (`optionIds`), and
 * an entry of a consolidated multi-question answer (either shape).
 *
 * @param {object|null} answer
 * @param {string} questionId
 * @param {string} optionId
 * @returns {boolean}
 */
export function answerChoosesOption(answer, questionId, optionId) {
  if (!answer || typeof answer !== 'object') return false;
  if (Array.isArray(answer.answers)) {
    return answer.answers.some(a => a && a.questionId === questionId &&
      answerChoosesOption(a, questionId, optionId));
  }
  if (Array.isArray(answer.optionIds)) return answer.optionIds.includes(optionId);
  return answer.optionId === optionId;
}

/**
 * Build the consolidated `io.aee.ask-answer` content for a multi-question
 * payload (AC4). All question→option pairs are carried in `answers[]`; a single
 * resume message is sent only after the last question is answered. An entry
 * may also be a typed answer (`custom: true` + `text`, #2821) or a skipped
 * question (`skipped: true`, #2821 AC8) — see `consolidateAskAnswers`.
 *
 * @param {string} questionEventId  the question message's event_id
 * @param {Array<{questionId: string, optionId: string, label: string}>} answers
 * @returns {{'io.aee.ask-answer': object}}
 */
export function buildMultiAnswerContent(questionEventId, answers) {
  return { [ASK_ANSWER_FIELD]: { questionEventId, answers } };
}

/** What a skipped question reads as in the consolidated reply (#2821 AC8). */
export const SKIPPED_ANSWER_TEXT = '(skipped)';

/**
 * Build the plain-text body for the consolidated reply of a multi-question
 * payload (#2821 AC6). Each answer starts its own line with its position and
 * question header (`2. Branch: main`); a multi-line typed answer moves below
 * that line with every line indented, so a line that starts at column 0
 * always begins the next answer and the agent can tell which text belongs to
 * which question. A lone answer is sent as-is.
 *
 * @param {Array<{label?: string, text?: string, header?: string, skipped?: true}>} answers
 * @returns {string}
 */
export function multiAnswerText(answers) {
  const valueOf = (a) => (a.skipped ? SKIPPED_ANSWER_TEXT
    : typeof a.text === 'string' ? a.text : (a.label || ''));
  if (answers.length === 1) return valueOf(answers[0]);
  return answers.map((a, i) => {
    const prefix = a.header ? `${i + 1}. ${a.header}:` : `${i + 1}.`;
    const lines = valueOf(a).split(/\r?\n/);
    if (lines.length === 1) return `${prefix} ${lines[0]}`;
    return [prefix, ...lines.map(l => `   ${l}`)].join('\n');
  }).join('\n');
}

/**
 * The answer entry for a question answered by free text typed in the
 * composer (#2821 AC1/AC10). `label` mirrors `text` so every consumer that
 * only knows labels (transcript, runtime fallback) still shows the answer.
 *
 * @param {{questionId: string}} q
 * @param {string} text
 * @returns {{questionId: string, custom: true, text: string, label: string}|null}
 */
export function buildTypedAnswer(q, text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!q || !value) return null;
  return { questionId: q.questionId, custom: true, text: value, label: value };
}

/** The empty step progress of a multi-question card (#1799, #2821). */
export const EMPTY_ASK_PROGRESS = Object.freeze({ openIdx: 0, answers: Object.freeze({}) });

/**
 * Turn the per-question answers held during stepping into the ordered
 * `answers[]` of the consolidated reply. Each entry carries its question's
 * header (the runtime labels the resume prompt with it). With `skipRemaining`
 * every unanswered question becomes a `skipped` entry (#2821 AC8); otherwise
 * unanswered questions are left out.
 *
 * @param {Array<{questionId: string, header?: string}>} questions
 * @param {Object<string, object>} answersById
 * @param {{skipRemaining?: boolean}} [opts]
 * @returns {Array<object>}
 */
export function consolidateAskAnswers(questions, answersById, { skipRemaining = false } = {}) {
  const out = [];
  for (const q of questions) {
    const a = answersById?.[q.questionId];
    let entry;
    if (a && a.custom) {
      entry = { questionId: q.questionId, custom: true, text: a.text, label: a.label };
    } else if (a && Array.isArray(a.optionIds)) {
      entry = { questionId: q.questionId, optionIds: a.optionIds, labels: a.labels, label: a.label };
    } else if (a) {
      entry = { questionId: q.questionId, optionId: a.optionId, label: a.label };
    } else if (skipRemaining) {
      entry = { questionId: q.questionId, skipped: true };
    } else {
      continue;
    }
    if (q.header) entry.header = q.header;
    out.push(entry);
  }
  return out;
}

/**
 * Complete the open step of a multi-question card with `value` — a clicked
 * option, a submitted multi-select answer, or a typed answer (#2821). Earlier
 * answers are kept (AC2). An intermediate step only advances `openIdx`; the
 * last step returns the consolidated `answers` to send (AC3) and leaves the
 * progress on that step, so a failed send can simply be retried. A value for
 * any step other than the open one is ignored (stale click).
 *
 * @param {{openIdx: number, answers: Object<string, object>}|null|undefined} progress
 * @param {Array<{questionId: string, header?: string}>} questions
 * @param {number} qi      index of the answered question
 * @param {object} value   the answer for that question
 * @returns {{progress: {openIdx: number, answers: Object<string, object>}, answers: Array|null}}
 */
export function advanceAskProgress(progress, questions, qi, value) {
  const cur = progress || EMPTY_ASK_PROGRESS;
  if (!Array.isArray(questions) || qi !== cur.openIdx || !questions[qi] || !value) {
    return { progress: cur, answers: null };
  }
  const answers = { ...cur.answers, [questions[qi].questionId]: value };
  if (qi < questions.length - 1) {
    return { progress: { openIdx: qi + 1, answers }, answers: null };
  }
  return { progress: { openIdx: qi, answers }, answers: consolidateAskAnswers(questions, answers) };
}

/**
 * The answer a consolidated reply / step progress holds for one question, or
 * null — used to render a typed (custom) or skipped answer under it.
 *
 * @param {Array<object>|null} answers   `answers[]` of an ask-answer record
 * @param {string} questionId
 * @returns {object|null}
 */
export function answerForQuestion(answers, questionId) {
  if (!Array.isArray(answers)) return null;
  return answers.find(a => a && a.questionId === questionId) || null;
}

/**
 * The multi-question card a free-text composer message should answer
 * (#2821 AC1), or null. Only the newest message qualifies, only while it is
 * an unanswered question with more than one question — a lone question keeps
 * today's behaviour (a typed reply is already a complete answer).
 *
 * @param {Array<object>} messages
 * @param {Map<string, object>} answersByQuestion  from `indexAskAnswers`
 * @returns {{eventId: string, question: {questions: Array}}|null}
 */
export function activeMultiQuestionCard(messages, answersByQuestion) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || !last[ASK_QUESTION_FIELD] || typeof last.event_id !== 'string') return null;
  if (answersByQuestion?.has?.(last.event_id)) return null;
  const question = normalizeAskQuestion(last[ASK_QUESTION_FIELD]);
  if (!question || question.questions.length < 2) return null;
  return { eventId: last.event_id, question };
}

/**
 * Whether a composer send goes to the active question card (#2821 AC1) or is
 * posted as a normal chat message. Only plain text qualifies: a draft with an
 * attachment (an uploaded `@chat-uploads/…` reference) or a dictated voice
 * transcript keeps today's behaviour and supersedes the card.
 *
 * @param {object} args
 * @param {string} args.text
 * @param {boolean} [args.hasAttachments]
 * @param {boolean} [args.dictated]
 * @returns {boolean}
 */
export function composerAnswersCard({ text, hasAttachments = false, dictated = false }) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (hasAttachments || dictated) return false;
  return !/@chat-uploads\//.test(text);
}

/**
 * The composer placeholder while a multi-question card is active (#2821 AC4).
 *
 * @param {number} openIdx
 * @param {number} total
 * @returns {string}
 */
export function askComposerPlaceholder(openIdx, total) {
  return `Answer question ${openIdx + 1} of ${total}…`;
}

/**
 * Return the progress label ("Question X of N") shown on the active step of a
 * multi-question card, or null for a single-question payload.
 *
 * @param {number} openIdx   0-based index of the currently-open question
 * @param {number} total     total number of questions in the payload
 * @returns {string|null}
 */
export function questionProgressLabel(openIdx, total) {
  if (total <= 1) return null;
  return `Question ${openIdx + 1} of ${total}`;
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
 * `superseded` (#2821 AC9) marks an unanswered question that something else
 * came after — a multi-question card then shows only the questions the user
 * reached instead of expanding to all of them. A merely disabled question is
 * not superseded: it keeps its step view.
 *
 * @param {object} args
 * @param {number} args.index            this message's index in `messages`
 * @param {number} args.messageCount     messages.length
 * @param {object|undefined} args.answer  the matching answer record, if any
 * @param {boolean} [args.disabled]      composer disabled (sending / offline)
 * @returns {{answerable: boolean, superseded: boolean, answeredOptionId: string|null,
 *            answeredLabel: string|null, answeredOptionIds: string[]|null, multiAnswers: Array|null}}
 */
export function questionState({ index, messageCount, answer, disabled = false }) {
  const isLast = index === messageCount - 1;
  const answered = !!answer;
  return {
    answerable: isLast && !answered && !disabled,
    superseded: !isLast && !answered,
    answeredOptionId: answered && typeof answer.optionId === 'string' ? answer.optionId : null,
    answeredLabel: answered && typeof answer.label === 'string' ? answer.label : null,
    // Populated when a single multi-select question was answered (#2523).
    answeredOptionIds: answered && Array.isArray(answer.optionIds) ? answer.optionIds : null,
    // Populated when a consolidated multi-question reply was sent (AC4 shape).
    multiAnswers: answered && Array.isArray(answer.answers) ? answer.answers : null,
  };
}
