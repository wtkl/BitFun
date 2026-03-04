/**
 * AskUserQuestion tool card component
 * Displays multiple questions, collects user answers and submits them
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Loader2, AlertCircle, Send, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { createLogger } from '@/shared/utils/logger';
import { Button } from '@/component-library';
import './AskUserQuestionCard.scss';

const log = createLogger('AskUserQuestionCard');

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionData {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export const AskUserQuestionCard: React.FC<ToolCardProps> = ({
  toolItem
}) => {
  const { t } = useTranslation('flow-chat');
  const { status, toolCall, toolResult } = toolItem;
  
  const getQuestions = (): QuestionData[] => {
    if (!toolCall?.input) return [];
    const input = toolCall.input;
    
    if (input.questions && Array.isArray(input.questions)) {
      return input.questions.map((q: any) => ({
        question: q.question || '',
        header: q.header || '',
        options: q.options || [],
        multiSelect: q.multiSelect || false
      }));
    }
    
    return [];
  };

  const questions = useMemo(() => getQuestions(), [toolCall?.input]);
  
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [otherInputs, setOtherInputs] = useState<Record<number, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const isAllAnswered = useCallback(() => {
    if (questions.length === 0) return false;
    
    for (let i = 0; i < questions.length; i++) {
      const answer = answers[i];
      if (!answer) return false;
      if (Array.isArray(answer) && answer.length === 0) return false;
      if (typeof answer === 'string' && answer === '') return false;
    }
    return true;
  }, [answers, questions.length]);

  const handleSingleChange = useCallback((questionIndex: number, value: string) => {
    setAnswers(prev => ({
      ...prev,
      [questionIndex]: value
    }));
  }, []);

  const handleMultiChange = useCallback((questionIndex: number, value: string, checked: boolean) => {
    setAnswers(prev => {
      const current = prev[questionIndex];
      const currentArray = Array.isArray(current) ? current : [];
      
      if (checked) {
        return { ...prev, [questionIndex]: [...currentArray, value] };
      } else {
        return { ...prev, [questionIndex]: currentArray.filter(v => v !== value) };
      }
    });
  }, []);

  const handleOtherInputChange = useCallback((questionIndex: number, value: string) => {
    setOtherInputs(prev => ({
      ...prev,
      [questionIndex]: value
    }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!isAllAnswered() || isSubmitting || isSubmitted) return;

    const toolId = toolItem.id;
    setIsSubmitting(true);
    try {
      const processedAnswers: Record<string, string | string[]> = {};
      
      for (let i = 0; i < questions.length; i++) {
        const answer = answers[i];
        const otherInput = otherInputs[i] || '';
        
        if (Array.isArray(answer)) {
          processedAnswers[String(i)] = answer.map(v => 
            v === 'Other' ? (otherInput || 'Other') : v
          );
        } else {
          processedAnswers[String(i)] = answer === 'Other' ? (otherInput || 'Other') : answer;
        }
      }

      const answersPayload = processedAnswers;
      
      await toolAPI.submitUserAnswers(toolId, answersPayload);
      
      setIsSubmitted(true);
    } catch (error) {
      log.error('Failed to submit answers', { toolId, error });
    } finally {
      setIsSubmitting(false);
    }
  }, [toolItem.id, answers, otherInputs, questions.length, isAllAnswered, isSubmitting, isSubmitted]);

  const getStatusIcon = () => {
    if (status === 'completed') {
      return null;
    }
    if (isSubmitting) {
      return <Loader2 size={16} className="status-icon-loading animate-spin" />;
    }
    return <AlertCircle size={16} className="status-icon-waiting" />;
  };

  const getStatusText = () => {
    if (status === 'completed') return t('toolCards.askUser.completed');
    if (isSubmitted) return t('toolCards.askUser.submittedWaiting');
    if (isSubmitting) return t('toolCards.askUser.submitting');
    return t('toolCards.askUser.waitingAnswer');
  };

  const renderQuestion = (q: QuestionData, questionIndex: number) => {
    const answer = answers[questionIndex];
    const otherInput = otherInputs[questionIndex] || '';
    
    const isOtherSelected = q.multiSelect 
      ? Array.isArray(answer) && answer.includes('Other')
      : answer === 'Other';

    const inputName = `question-${questionIndex}`;

    return (
      <div key={questionIndex} className="ask-question-item">
        <div className="question-item-header">
          <span className="question-header-chip">{q.header}</span>
          <span className="question-text">{q.question}</span>
        </div>
        
        <div className="question-options">
          {q.options.map((option, optIdx) => (
            <label key={optIdx} className="option-label">
              {q.multiSelect ? (
                <>
                  <input
                    type="checkbox"
                    name={inputName}
                    value={option.label}
                    checked={Array.isArray(answer) && answer.includes(option.label)}
                    onChange={(e) => handleMultiChange(questionIndex, option.label, e.target.checked)}
                    disabled={isSubmitted || status === 'completed'}
                  />
                  <span className="custom-checkbox" />
                </>
              ) : (
                <>
                  <input
                    type="radio"
                    name={inputName}
                    value={option.label}
                    checked={answer === option.label}
                    onChange={(e) => handleSingleChange(questionIndex, e.target.value)}
                    disabled={isSubmitted || status === 'completed'}
                  />
                  <span className="custom-radio" />
                </>
              )}
              <div className="option-content">
                <div className="option-label-text">{option.label}</div>
                <div className="option-description">{option.description}</div>
              </div>
            </label>
          ))}
          
          {!isOtherSelected ? (
            <label className="option-label option-other">
              {q.multiSelect ? (
                <>
                  <input
                    type="checkbox"
                    name={inputName}
                    value="Other"
                    checked={false}
                    onChange={(e) => {
                      if (e.target.checked) {
                        handleMultiChange(questionIndex, 'Other', true);
                      }
                    }}
                    disabled={isSubmitted || status === 'completed'}
                  />
                  <span className="custom-checkbox" />
                </>
              ) : (
                <>
                  <input
                    type="radio"
                    name={inputName}
                    value="Other"
                    checked={false}
                    onChange={() => handleSingleChange(questionIndex, 'Other')}
                    disabled={isSubmitted || status === 'completed'}
                  />
                  <span className="custom-radio" />
                </>
              )}
              <div className="option-content">
                <div className="option-label-text">{t('toolCards.askUser.other')}</div>
                <div className="option-description">{t('toolCards.askUser.customInputHint')}</div>
              </div>
            </label>
          ) : (
            <div className="option-other-input">
              {q.multiSelect ? (
                <>
                  <input
                    type="checkbox"
                    name={inputName}
                    value="Other"
                    checked={true}
                    onChange={(e) => {
                      if (!e.target.checked) {
                        handleMultiChange(questionIndex, 'Other', false);
                      }
                    }}
                    disabled={isSubmitted || status === 'completed'}
                  />
                  <span className="custom-checkbox" />
                </>
              ) : (
                <>
                  <input
                    type="radio"
                    name={inputName}
                    value="Other"
                    checked={true}
                    onChange={() => {}}
                    disabled={isSubmitted || status === 'completed'}
                  />
                  <span className="custom-radio" />
                </>
              )}
              <input
                type="text"
                className="other-input-inline"
                placeholder={t('toolCards.askUser.pleaseSpecify')}
                value={otherInput}
                onChange={(e) => handleOtherInputChange(questionIndex, e.target.value)}
                disabled={isSubmitted || status === 'completed'}
                autoFocus
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  const getAnswerDisplay = (questionIndex: number): string => {
    const answer = answers[questionIndex];
    const otherInput = otherInputs[questionIndex] || '';
    
    if (!answer) return '';
    if (Array.isArray(answer)) {
      return answer.map(v => v === 'Other' ? otherInput || 'Other' : v).join(', ');
    }
    return answer === 'Other' ? otherInput || 'Other' : answer;
  };

  const getAnswersSummary = (): string => {
    return questions.map((q, idx) => {
      const answerText = getAnswerDisplay(idx);
      return `${q.header}: ${answerText || t('toolCards.askUser.notAnswered')}`;
    }).join(' | ');
  };

  const renderResult = () => {
    if (!toolResult?.result) return null;
    
    const result = typeof toolResult.result === 'string' 
      ? JSON.parse(toolResult.result) 
      : toolResult.result;
    
    if (result.status === 'timeout') {
      return (
        <div className="result-timeout">
          <AlertCircle size={16} />
          <span>{t('toolCards.askUser.timeout')}</span>
        </div>
      );
    }
    
    return null;
  };

  if (questions.length === 0) {
    return (
      <div className="ask-user-question-card status-error">
        <div className="error-message">{t('toolCards.askUser.parseError')}</div>
      </div>
    );
  }

  return (
    <div className={`ask-user-question-card status-${status}`}>
      {status !== 'completed' ? (
        <>
          <div className="card-header-row">
            <div className="card-title">
              <span className="questions-count">{t('toolCards.askUser.questionsCount', { count: questions.length })}</span>
            </div>
            <div className="header-actions">
              <Button
                variant="primary"
                size="small"
                className="submit-button"
                onClick={handleSubmit}
                disabled={!isAllAnswered() || isSubmitting}
                isLoading={isSubmitting}
                title={!isAllAnswered() ? t('toolCards.askUser.answerAllBeforeSubmit') : ""}
              >
                {isSubmitting ? (
                  <span>{t('toolCards.askUser.submitting')}</span>
                ) : (
                  <>
                    <Send size={14} />
                    <span>{t('toolCards.askUser.submit')}</span>
                  </>
                )}
              </Button>
              <div className="tool-status">
                {getStatusIcon()}
                <span className="status-text">{getStatusText()}</span>
              </div>
            </div>
          </div>

          <div className="questions-container">
            {questions.map((q, idx) => renderQuestion(q, idx))}
          </div>
        </>
      ) : (
        <>
          <div 
            className="completed-summary"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <div className="summary-content">
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="summary-questions-count">{t('toolCards.askUser.questionsAnswered', { count: questions.length })}</span>
              <span className="summary-arrow">→</span>
              <span className="summary-answer">{getAnswersSummary()}</span>
            </div>
            <div className="tool-status">
              {getStatusIcon()}
              <span className="status-text">{getStatusText()}</span>
            </div>
          </div>

          {isExpanded && (
            <div className="questions-container expanded">
              {questions.map((q, idx) => renderQuestion(q, idx))}
            </div>
          )}

          {renderResult()}
        </>
      )}
    </div>
  );
};
