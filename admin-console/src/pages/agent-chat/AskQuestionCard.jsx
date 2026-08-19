import React from 'react';
import { Bot, Check } from 'lucide-react';

/**
 * Quick-reply question card (#1663).
 *
 * Renders an agent message that paused on Claude's `AskUserQuestion` tool as
 * clickable option controls beneath the question text. Clicking an option sends
 * its label as the user's reply (via `onAnswer`), exactly as if the human had
 * typed it — free-text typing stays available in the composer at all times.
 *
 * The structured `io.aee.ask-question` payload is rendered here in the Admin
 * Console; the same message's Markdown `body` (with the options as a bullet
 * list) is what other Matrix clients / older builds show, so no information is
 * lost when the buttons can't render (AC8). We therefore intentionally do NOT
 * render `body` here — the structured header/question text below is the same
 * content, and showing both would duplicate every option.
 *
 * MVP is single-choice (D1): one click submits immediately. Selection is final
 * (AC5) — once `answerable` is false the options no longer accept input and the
 * chosen one is marked; the parent decides answerability from transcript
 * position (`questionState` in `ask-question-view.js`).
 *
 * @param {object}  props
 * @param {{questions: Array}} props.question   normalized ask-question payload
 * @param {boolean} props.answerable            options accept a click
 * @param {?string} props.answeredOptionId      the chosen option (marks it), if any
 * @param {?string} props.answeredLabel         the chosen label (fallback match)
 * @param {(option: object) => void} props.onAnswer  called with the clicked option
 * @param {?string} props.time                  formatted timestamp for the footer
 */
export default function AskQuestionCard({
  question, answerable, answeredOptionId = null, answeredLabel = null, onAnswer, time = null,
}) {
  if (!question || !Array.isArray(question.questions) || question.questions.length === 0) {
    return null;
  }

  const isChosen = (opt) =>
    (answeredOptionId != null && opt.optionId === answeredOptionId) ||
    (answeredOptionId == null && answeredLabel != null && opt.label === answeredLabel);
  const answered = answeredOptionId != null || answeredLabel != null;

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
          {question.questions.map((q, qi) => (
            <QuestionBlock
              key={q.questionId || qi}
              q={q}
              answerable={answerable}
              answered={answered}
              isChosen={isChosen}
              onAnswer={onAnswer}
            />
          ))}
        </div>

        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          marginTop: 'var(--eb-space-0-5)',
          padding: '0 var(--eb-space-1)',
        }}>
          {answered ? 'answered' : (answerable ? 'awaiting your choice' : 'question')}
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
                // Answered-but-not-chosen options dim; a still-open question that
                // is simply not the newest message keeps full contrast but is
                // non-interactive.
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
