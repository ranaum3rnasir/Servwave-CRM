/**
 * spider.ts — Spider AI Agent API Client
 */

import api from '@/lib/axios';
import type { SpiderAssignmentsConfig, SpiderNotificationsConfig } from '@/stores/spiderWatcherStore';

export interface DispatchSpiderAlertPayload {
  leadId: string;
  stageLabel?: string;
  elapsedValue?: number;
  elapsedUnit?: string;
  elapsedSeconds?: number;
  assignments: SpiderAssignmentsConfig;
  notifications: SpiderNotificationsConfig;
  testEmail?: string;
}

export interface DispatchSpiderAlertResponse {
  ok: boolean;
  recipientCount: number;
  emailsSent: number;
  emailsSkippedOrFailed: number;
  smsSent: number;
  smsSkippedOrFailed: number;
  inAppEmitted: boolean;
  error?: string;
}

/**
 * Dispatches Email, SMS, and In-App alerts for an overdue lead via Spider AI Agent backend
 */
export async function dispatchSpiderAlertApi(
  payload: DispatchSpiderAlertPayload
): Promise<DispatchSpiderAlertResponse> {
  try {
    const response = await api.post<DispatchSpiderAlertResponse>(
      '/api/ai-farm/spider/dispatch-alert',
      payload
    );
    return response.data;
  } catch (err: any) {
    console.warn('[Spider API] Failed to dispatch Spider alert:', err?.response?.data || err?.message || err);
    return {
      ok: false,
      recipientCount: 0,
      emailsSent: 0,
      emailsSkippedOrFailed: 0,
      smsSent: 0,
      smsSkippedOrFailed: 0,
      inAppEmitted: false,
      error: err?.response?.data?.error || err?.message || 'Dispatch error',
    };
  }
}
