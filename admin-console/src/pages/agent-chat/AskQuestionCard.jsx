import React, { useState } from 'react';
import { Bot, Check } from 'lucide-react';
import {
  toggleSelection, buildSelectionAnswer, answerChoosesOption,
} from './ask-question-view.js';

/**
 * Quick-reply question card (#1663, #1799).
 *
 * Single-question payloads: one click submits immediately (unchanged, AC1).
 *
 * Multi-question payloads (#1799 AC2–AC6): questions are answered one at a
 * time. Only the current question is shown with interactive options; earlier
 * questions' choices are held in component state. When the last question is
 * answered, all choices are sent together in one consolidated reply (AC4).
 * Progress is shown as "Question X of N" (AC5). Intermediate clicks never
 * post a message and never resume the session (AC3).
 *
 * multiSelect questions (#2523): options toggle on click and an explicit
 * Submit commits the selection (disabled until one is picked). A lone
 * multi-select question calls `onAnswer({ isMultiSelect: true, answer })`;
 * inside a multi-question card, Submit completes that step like a click does.
 *
 * Answerability is still determined externally by `questionState` in
 * `ask-question-view.js` (newest message + not already answered — AC6).
 *
 * @param {object}  props
 * @param {{questions: Array}} props.question     normalized ask-question payload
 * @param {boolean} props.answerable              overall card is interactive
 * @param {?string} props.answeredOptionId        chosen option id (single-q answered)
 * @param {?string} props.answeredLabel           chosen label (single-q fallback match)
 * @param {?string[]} props.answeredOptionIds     chosen option ids (single multi-select q answered)
 * @param {?Array}  props.answeredMulti           [{questionId,optionId,label}] (multi-q answered)
 * @param {(arg: object|{isMulti:boolean,answers:Array}) => void} props.onAnswer
 * @param {?string} props.time                    formatted timestamp
 */
export default function AskQuestionCard({
  question, answerable, answeredOptionId = null, answeredLabel = null,
  answeredOptionIds = null, answeredMulti = null, onAnswer, time = null,
}) {
  const [openIdx, setOpenIdx] = useState(0);
  const [pendingAnswers, setPendingAnswers] = useState({});
  // Draft selections of multi-select questions, keyed by questionId (#2523).
  const [drafts, setDrafts] = useState({});

  if (!question || !Array.isArray(question.questions) || question.questions.length === 0) {
    return null;
  }

  const isMulti = question.questions.length > 1;
  const answered = answeredMulti != null || answeredOptionIds != null ||
    answeredOptionId != null || answeredLabel != null;

  // Determine if a specific option was chosen — covers every case:
  // (a) consolidated multi-answer was sent, (b) a lone multi-select question
  // was answered, (c) a multi-select draft, (d) locally-pending in active
  // multi, (e) single-question answered.
  const isChosen = (q, opt) => {
    if (answeredMulti) {
      return answerChoosesOption({ answers: answeredMulti }, q.questionId, opt.optionId);
    }
    if (answeredOptionIds) return answeredOptionIds.includes(opt.optionId);
    if (q.multiSelect && !answered) return (drafts[q.questionId] || []).includes(opt.optionId);
    if (isMulti) {
      return answerChoosesOption(pendingAnswers[q.questionId], q.questionId, opt.optionId);
    }
    return (answeredOptionId != null && opt.optionId === answeredOptionId) ||
      (answeredOptionId == null && answeredLabel != null && opt.label === answeredLabel);
  };

  // Complete one step of a multi-question card with `value` — a clicked
  // option, or a submitted multi-select answer (`optionIds`/`labels`).
  const commitStep = (q, qi, value) => {
    const updated = { ...pendingAnswers, [q.questionId]: value };
    const isLast = qi === question.questions.length - 1;
    if (!isLast) {
      // Intermediate question — hold locally, advance to the next (AC3).
      setPendingAnswers(updated);
      setOpenIdx(qi + 1);
    } else {
      // Last question — build and send the consolidated reply (AC4).
      const answers = question.questions.map(qItem => {
        const a = updated[qItem.questionId];
        if (!a) return null;
        return Array.isArray(a.optionIds)
          ? { questionId: qItem.questionId, optionIds: a.optionIds, labels: a.labels, label: a.label }
          : { questionId: qItem.questionId, optionId: a.optionId, label: a.label };
      }).filter(Boolean);
      onAnswer?.({ isMulti: true, answers });
    }
  };

  // Handle an option click.
  const handleOptionClick = (q, qi, opt) => {
    if (!answerable) return;
    if (q.multiSelect) {
      // Toggle only — nothing is sent until Submit (#2523).
      setDrafts(prev => ({ ...prev, [q.questionId]: toggleSelection(prev[q.questionId], opt.optionId) }));
      return;
    }
    if (isMulti) {
      commitStep(q, qi, opt);
    } else {
      onAnswer?.(opt);
    }
  };

  // Submit a multi-select question's selection (#2523).
  const handleSubmit = (q, qi) => {
    if (!answerable) return;
    const answer = buildSelectionAnswer(q, drafts[q.questionId]);
    if (!answer) return;
    if (isMulti) {
      commitStep(q, qi, answer);
    } else {
      onAnswer?.({ isMultiSelect: true, answer });
    }
  };

  // In active multi-question mode show only the open question; in all other
  // states (answered, superseded, single) show every question.
  const showCurrentOnly = isMulti && answerable && !answered;
  const visibleQuestions = showCurrentOnly
    ? [{ q: question.questions[openIdx], qi: openIdx }]
    : question.questions.map((q, qi) => ({ q, qi }));

  const footerText = answered
    ? 'answered'
    : isMulti && answerable
      ? `Question ${openIdx + 1} of ${question.questions.length} · awaiting your choice`
      : answerable
        ? 'awaiting your choice'
        : 'question';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 'var(--eb-space-2)',
      maxWidth: '100%',
    }}>
      <div style={{
        width: 28, height: 28,
        borderRadius: '50%',
        background: 'var(--eb-accent-muted)',
        border: '1px solid var(--eb-border-default)',
        color: 'var(--eb-accent-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Bot size={16} />
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        maxWidth: 'min(720px, 85%)',
        minWidth: 0,
      }}>
        <div style={{
          background: 'var(--eb-bg-surface)',
          color: 'var(--eb-text-primary)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          borderRadius: 'var(--eb-radius-lg)',
          border: '1px solid var(--eb-border-default)',
          fontSize: 'var(--chat-font-size, var(--eb-text-md))',
          lineHeight: 1.5,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-3)',
        }}>
          {visibleQuestions.map(({ q, qi }) => (
            <QuestionBlock
              key={q.questionId || qi}
              q={q}
              answerable={answerable && (!isMulti || qi === openIdx)}
              answered={answered}
              isChosen={(opt) => isChosen(q, opt)}
              onAnswer={(opt) => handleOptionClick(q, qi, opt)}
              canSubmit={(drafts[q.questionId] || []).length > 0}
              onSubmit={() => handleSubmit(q, qi)}
            />
          ))}
        </div>

        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          marginTop: 'var(--eb-space-0-5)',
          padding: '0 var(--eb-space-1)',
        }}>
          {footerText}
          {time ? ` · ${time}` : ''}
        </div>
      </div>
    </div>
  );
}

function QuestionBlock({ q, answerable, answered, isChosen, onAnswer, canSubmit, onSubmit }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
      {q.header && (
        <div style={{ fontWeight: 'var(--eb-font-semibold)' }}>{q.header}</div>
      )}
      {q.question && (
        <div style={{ color: 'var(--eb-text-primary)' }}>{q.question}</div>
      )}
      {q.multiSelect && answerable && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          Select one or more, then submit.
        </div>
      )}
      {/* Options as a group of buttons; long lists wrap onto new rows. */}
      <div
        role="group"
        aria-label={q.question || q.header || 'Answer options'}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--eb-space-2)',
          marginTop: 'var(--eb-space-1)',
        }}
      >
        {q.options.map((opt) => {
          const chosen = isChosen(opt);
          const clickable = answerable;
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={!clickable}
              aria-pressed={chosen}
              onClick={clickable ? () => onAnswer(opt) : undefined}
              title={opt.description || opt.label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                textAlign: 'left',
                padding: 'var(--eb-space-1) var(--eb-space-3)',
                borderRadius: 'var(--eb-radius-md)',
                border: `1px solid ${chosen ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                background: chosen ? 'var(--eb-accent-muted)' : 'var(--eb-bg-elevated)',
                color: 'var(--eb-text-primary)',
                font: 'inherit',
                fontSize: 'var(--eb-text-sm)',
                cursor: clickable ? 'pointer' : 'default',
                opacity: answered && !chosen ? 0.55 : 1,
                maxWidth: '100%',
              }}
            >
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontWeight: 'var(--eb-font-medium)',
              }}>
                {chosen && <Check size={13} aria-hidden="true" />}
                {opt.label}
              </span>
              {opt.description && (
                <span style={{
                  fontSize: 'var(--eb-text-xs)',
                  color: 'var(--eb-text-secondary)',
                  overflowWrap: 'anywhere',
                }}>
                  {opt.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {q.multiSelect && answerable && (
        <div>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={canSubmit ? onSubmit : undefined}
            style={{
              padding: 'var(--eb-space-1) var(--eb-space-3)',
              borderRadius: 'var(--eb-radius-md)',
              border: '1px solid var(--eb-accent-primary)',
              background: canSubmit ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
              color: canSubmit ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
              font: 'inherit',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              cursor: canSubmit ? 'pointer' : 'default',
            }}
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}
