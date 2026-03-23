'use client';

import { Button } from '@chakra-ui/react';
import {
  STEP_TYPE_OPTIONS,
  STEP_TYPE_META,
  TYPE_COLORS,
  type EditorStep,
  type StepType,
} from '../types';

interface NodeEditPanelProps {
  step: EditorStep;
  onUpdate: (updater: (step: EditorStep) => EditorStep) => void;
  onChangeType: (newType: StepType) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function NodeEditPanel({
  step,
  onUpdate,
  onChangeType,
  onDelete,
  onClose,
}: NodeEditPanelProps) {
  const meta = STEP_TYPE_META[step.type];
  const colors = TYPE_COLORS[step.type];
  const IconComponent = meta.icon;

  return (
    <div
      style={{
        width: 350,
        height: '100%',
        borderLeft: '1px solid #E4E4E4',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid #E4E4E4',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 4,
              background: `${colors.accent}15`,
              border: '1px solid #E4E4E4',
            }}
          >
            <IconComponent size={16} color={colors.accent} />
          </div>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#0C0C0C' }}>Edit {meta.label}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: 4,
            border: 'none',
            background: '#E8E8E8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            color: '#5F5F5F',
          }}
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Type selector */}
        <div>
          <label
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#5F5F5F',
              display: 'block',
              marginBottom: 6,
            }}
          >
            Step Type
          </label>
          <select
            value={step.type}
            onChange={(e) => onChangeType(e.target.value as StepType)}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #E4E4E4',
              borderRadius: 4,
              fontSize: 13,
              background: '#F7F7F7',
              color: '#0C0C0C',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {STEP_TYPE_OPTIONS.map((opt) => (
              <option key={opt.type} value={opt.type}>
                {opt.label} — {opt.hint}
              </option>
            ))}
          </select>
        </div>

        {/* Type-specific fields */}
        {(step.type === 'step' || step.type === 'save') && (
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#5F5F5F',
                display: 'block',
                marginBottom: 6,
              }}
            >
              Description
            </label>
            <textarea
              value={step.description}
              onChange={(e) => onUpdate((s) => ({ ...s, description: e.target.value }))}
              rows={4}
              placeholder={step.type === 'save' ? 'What should be saved?' : 'Describe the action'}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #E4E4E4',
                borderRadius: 4,
                fontSize: 13,
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit',
                background: '#F7F7F7',
                color: '#0C0C0C',
              }}
            />
          </div>
        )}

        {step.type === 'extract' && (
          <>
            <div>
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#5F5F5F',
                  display: 'block',
                  marginBottom: 6,
                }}
              >
                Description
              </label>
              <textarea
                value={step.description}
                onChange={(e) => onUpdate((s) => ({ ...s, description: e.target.value }))}
                rows={3}
                placeholder="What data should be extracted?"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #E4E4E4',
                  borderRadius: 4,
                  fontSize: 13,
                  resize: 'vertical',
                  outline: 'none',
                  fontFamily: 'inherit',
                  background: '#F7F7F7',
                  color: '#0C0C0C',
                }}
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#5F5F5F',
                  display: 'block',
                  marginBottom: 6,
                }}
              >
                Data Schema
              </label>
              <input
                type="text"
                value={step.dataSchema ?? ''}
                onChange={(e) => onUpdate((s) => ({ ...s, dataSchema: e.target.value }))}
                placeholder="e.g. { name: string, email: string }"
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #E4E4E4',
                  borderRadius: 4,
                  fontSize: 13,
                  outline: 'none',
                  background: '#F7F7F7',
                  color: '#0C0C0C',
                }}
              />
            </div>
          </>
        )}

        {(step.type === 'navigate' || step.type === 'tab_navigate') && (
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#5F5F5F',
                display: 'block',
                marginBottom: 6,
              }}
            >
              URL
            </label>
            <input
              type="text"
              value={step.url}
              onChange={(e) => onUpdate((s) => ({ ...s, url: e.target.value }))}
              placeholder="https://example.com"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #E4E4E4',
                borderRadius: 4,
                fontSize: 13,
                outline: 'none',
                background: '#F7F7F7',
                color: '#0C0C0C',
              }}
            />
          </div>
        )}

        {step.type === 'conditional' && (
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#5F5F5F',
                display: 'block',
                marginBottom: 6,
              }}
            >
              Condition
            </label>
            <input
              type="text"
              value={step.condition}
              onChange={(e) => onUpdate((s) => ({ ...s, condition: e.target.value }))}
              placeholder="e.g. if logged in"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #E4E4E4',
                borderRadius: 4,
                fontSize: 13,
                outline: 'none',
                background: '#F7F7F7',
                color: '#0C0C0C',
              }}
            />
          </div>
        )}

        {step.type === 'switch_tab' && (
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#5F5F5F',
                display: 'block',
                marginBottom: 6,
              }}
            >
              Tab Number
            </label>
            <select
              value={step.tabIndex + 1}
              onChange={(e) => onUpdate((s) => ({ ...s, tabIndex: Number(e.target.value) - 1 }))}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #E4E4E4',
                borderRadius: 4,
                fontSize: 13,
                background: '#F7F7F7',
                color: '#0C0C0C',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
        )}

        {step.type === 'loop' && (
          <div>
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#5F5F5F',
                display: 'block',
                marginBottom: 6,
              }}
            >
              Description
            </label>
            <textarea
              value={step.description}
              onChange={(e) => onUpdate((s) => ({ ...s, description: e.target.value }))}
              rows={3}
              placeholder="What are we looping over?"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid #E4E4E4',
                borderRadius: 4,
                fontSize: 13,
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit',
                background: '#F7F7F7',
                color: '#0C0C0C',
              }}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '12px 20px',
          borderTop: '1px solid #E4E4E4',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <Button type="button" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}
