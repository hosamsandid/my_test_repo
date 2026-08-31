import React, { useState } from 'react';
import { Bot, Check } from 'lucide-react';

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
 * post a message and never resume the session (AC3). multiSelect questions
 * fall through to plain text (unchanged, AC7).
 *
 * Answerability is still determined externally by `questionState` in
 * `ask-question-view.js` (newest message + not already answered — AC6).
 *
 * @param {object}  props
 * @param {{questions: Array}} props.question     normalized ask-question payload
 * @param {boolean} props.answerable              overall card is interactive
 * @param {?string} props.answeredOptionId        chosen option id (single-q answered)
 * @param {?string} props.answeredLabel           chosen label (single-q fallback match)
 * @param {?Array}  props.answeredMulti           [{questionId,optionId,label}] (multi-q answered)
 * @param {(arg: object|{isMulti:boolean,answers:Array}) => void} props.onAnswer
 * @param {?string} props.time                    formatted timestamp
 */
export default function AskQuestionCard({
  question, answerable, answeredOptionId = null, answeredLabel = null,
  answeredMulti = null, onAnswer, time = null,
}) {
  const [openIdx, setOpenIdx] = useState(0);
  const [pendingAnswers, setPendingAnswers] = useState({});

  if (!question || !Array.isArray(question.questions) || question.questions.length === 0) {
    return null;
  }

  const isMulti = question.questions.length > 1;
  const answered = answeredMulti != null || answeredOptionId != null || answeredLabel != null;

  // Determine if a specific option was chosen — covers all three cases:
  // (a) consolidated multi-answer was sent, (b) locally-pending in active multi,
  // (c) single-question answered.
  const isChosen = (q, opt) => {
    if (answeredMulti) {
      return answeredMulti.some(
        a => a.questionId === q.questionId && a.optionId === opt.optionId,
      );
    }
    if (isMulti) {
      const p = pendingAnswers[q.questionId];
      return p != null && p.optionId === opt.optionId;
    }
    return (answeredOptionId != null && opt.optionId === answeredOptionId) ||
      (answeredOptionId == null && answeredLabel != null && opt.label === answeredLabel);
  };

  // Handle an option click.
  const handleOptionClick = (q, qi, opt) => {
    if (!answerable) return;
    if (isMulti) {
      const updated = { ...pendingAnswers, [q.questionId]: opt };
      const isLast = qi === question.questions.length - 1;
      if (!isLast) {
        // Intermediate question — hold locally, advance to the next (AC3).
        setPendingAnswers(updated);
        setOpenIdx(qi + 1);
      } else {
        // Last question — build and send the consolidated reply (AC4).
        const answers = question.questions.map(qItem => {
          const a = updated[qItem.questionId];
          return a ? { questionId: qItem.questionId, optionId: a.optionId, label: a.label } : null;
        }).filter(Boolean);
        onAnswer?.({ isMulti: true, answers });
      }
    } else {
      onAnswer?.(opt);
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

function QuestionBlock({ q, answerable, answered, isChosen, onAnswer }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
      {q.header && (
        <div style={{ fontWeight: 'var(--eb-font-semibold)' }}>{q.header}</div>
      )}
      {q.question && (
        <div style={{ color: 'var(--eb-text-primary)' }}>{q.question}</div>
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
    </div>
  );
}
