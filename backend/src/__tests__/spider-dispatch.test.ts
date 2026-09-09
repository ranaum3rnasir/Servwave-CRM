import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { sendAutomationEmail } from '../lib/email';
import { sendCtmSms } from '../lib/ctm/sendSms';
import { mockAuthAs, authHeader } from './helpers';

vi.mock('../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email')>();
  return {
    ...actual,
    sendAutomationEmail: vi.fn().mockResolvedValue({ status: 'sent', providerMessageId: 'resend-msg-123' }),
  };
});

vi.mock('../lib/ctm/sendSms', () => ({
  sendCtmSms: vi.fn().mockResolvedValue({ delivered: true }),
}));

describe('Spider Agent Alert Dispatch (Email & SMS)', () => {
  const mockOrgId = '00000000-0000-4000-a000-000000000001';
  const mockUserId = '11111111-1111-4000-a000-111111111111';
  const mockLeadId = '22222222-2222-4000-a000-222222222222';
  const mockCustomerId = '33333333-3333-4000-a000-333333333333';
  const mockOwnerId = '44444444-4444-4000-a000-444444444444';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches email alerts to resolved recipients when email notification is enabled', async () => {
    const { dispatchSpiderAlerts } = await import('../services/notifications/spiderDispatch.service');

    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '101',
      customer_id: mockCustomerId,
      assigned_to: mockOwnerId,
      assigned_to_user_id: mockOwnerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'Jane',
        last_name: 'Doe',
        phone: '+12015551234',
        service_street: '123 Main St',
        service_city: 'Paterson',
        service_state: 'NJ',
        service_postal_code: '07501',
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha HVAC',
      brand_color: '#0c2d3a',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([
        { id: mockUserId, role: 'ADMIN' },
        { id: mockOwnerId, role: 'SALES' },
      ]) // loadRoleHolders
      .mockResolvedValueOnce([
        { id: mockOwnerId, email: 'owner@alphahvac.com', phone: '+12015559999', first_name: 'John', last_name: 'Owner' },
      ]); // recipient users

    const result = await dispatchSpiderAlerts({
      organizationId: mockOrgId,
      leadId: mockLeadId,
      stageLabel: 'Contacted',
      elapsedValue: 3,
      elapsedUnit: 'Day',
      assignments: {
        owner: true,
        adminRoles: [],
        users: [],
      },
      notifications: {
        email: true,
        sms: false,
        inApp: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.emailsSent).toBe(1);
    expect(sendAutomationEmail).toHaveBeenCalledTimes(1);

    const emailCall = (sendAutomationEmail as any).mock.calls[0][0];
    expect(emailCall.to).toBe('owner@alphahvac.com');
    expect(emailCall.subject).toContain('[Spider AI Alert] LD-101 (Jane Doe) is overdue in Contacted');
    expect(emailCall.html).toContain('Spider AI Lead Watcher Alert');
    expect(emailCall.html).toContain('3 Days');
  });

  it('dispatches SMS alerts to recipient phone number when SMS notification is enabled', async () => {
    const { dispatchSpiderAlerts } = await import('../services/notifications/spiderDispatch.service');

    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '102',
      customer_id: mockCustomerId,
      assigned_to: mockOwnerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'Bob',
        last_name: 'Smith',
        phone: '+12015551111',
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha HVAC',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([
        { id: mockOwnerId, role: 'ADMIN' },
      ])
      .mockResolvedValueOnce([
        { id: mockOwnerId, email: 'admin@alphahvac.com', phone: '+12015558888', first_name: 'Admin', last_name: 'User' },
      ]);

    (prisma.messageThread.findFirst as any).mockResolvedValue(null);
    (prisma.messageThread.create as any).mockResolvedValue({ id: 'thread-123' });
    (prisma.message.create as any).mockResolvedValue({ id: 'msg-123' });

    const result = await dispatchSpiderAlerts({
      organizationId: mockOrgId,
      leadId: mockLeadId,
      stageLabel: 'New',
      elapsedValue: 4,
      elapsedUnit: 'Hour',
      assignments: {
        owner: true,
      },
      notifications: {
        email: false,
        sms: true,
        inApp: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.smsSent).toBe(1);
    expect(sendCtmSms).toHaveBeenCalledTimes(1);

    const smsCall = (sendCtmSms as any).mock.calls[0][1];
    expect(smsCall.toE164).toBe('+12015558888');
    expect(smsCall.body).toContain('[Spider Alert] Lead LD-102 (Bob Smith) is overdue in stage "New"');
  });

  it('handles API endpoint POST /api/ai-farm/spider/dispatch-alert correctly', async () => {
    mockAuthAs('admin');

    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '103',
      customer_id: mockCustomerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'Alice',
        last_name: 'Walker',
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha HVAC',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/api/ai-farm/spider/dispatch-alert')
      .set(authHeader('admin'))
      .send({
        leadId: mockLeadId,
        stageLabel: 'Estimate',
        elapsedValue: 2,
        elapsedUnit: 'Day',
        assignments: {
          adminRoles: ['ADMIN'],
        },
        notifications: {
          email: true,
          sms: true,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('demonstrates and logs the exact dispatched Email and SMS text messages end-to-end', async () => {
    mockAuthAs('admin');

    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '105',
      customer_id: mockCustomerId,
      assigned_to: mockOwnerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'Robert',
        last_name: 'Johnson',
        phone: '+12015554321',
        service_street: '742 Evergreen Terrace',
        service_city: 'Springfield',
        service_state: 'NJ',
        service_postal_code: '07081',
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha Home Services',
      brand_color: '#0c2d3a',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([
        { id: mockOwnerId, role: 'ADMIN' },
      ])
      .mockResolvedValueOnce([
        { id: mockOwnerId, email: 'admin@alphahomeservices.com', phone: '+12015559876', first_name: 'Sarah', last_name: 'Connor' },
      ]);

    (prisma.messageThread.findFirst as any).mockResolvedValue(null);
    (prisma.messageThread.create as any).mockResolvedValue({ id: 'thread-999' });
    (prisma.message.create as any).mockResolvedValue({ id: 'msg-999' });

    const res = await request(app)
      .post('/api/ai-farm/spider/dispatch-alert')
      .set(authHeader('admin'))
      .send({
        leadId: mockLeadId,
        stageLabel: 'Walkthrough Scheduled',
        elapsedValue: 5,
        elapsedUnit: 'Day',
        assignments: {
          adminRoles: ['ADMIN'],
          owner: true,
        },
        notifications: {
          email: true,
          sms: true,
          inApp: true,
          redFrame: true,
        },
      });

    console.log('\n================== 🕷️ SPIDER ALERT DISPATCH TEST LOGS ==================');
    console.log('API HTTP Status:', res.status);
    console.log('API Response Body:', JSON.stringify(res.body, null, 2));

    const emailCalls = (sendAutomationEmail as any).mock.calls;
    if (emailCalls.length > 0) {
      console.log('\n--- 📧 DISPATCHED EMAIL LOG ---');
      console.log('Recipient To:', emailCalls[0][0].to);
      console.log('Subject:', emailCalls[0][0].subject);
      console.log('Plaintext Content:\n' + emailCalls[0][0].text);
    }

    const smsCalls = (sendCtmSms as any).mock.calls;
    if (smsCalls.length > 0) {
      console.log('\n--- 📱 DISPATCHED SMS LOG ---');
      console.log('Destination Number:', smsCalls[0][1].toE164);
      console.log('SMS Message Body:\n' + smsCalls[0][1].body);
    }
    console.log('========================================================================\n');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.emailsSent).toBe(1);
    expect(res.body.smsSent).toBe(1);
  });

  it('dispatches directly to requested test email attaorakzai786@gmail.com', async () => {
    mockAuthAs('admin');

    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '107',
      customer_id: mockCustomerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'David',
        last_name: 'Miller',
        phone: '+12015550000',
        service_street: '456 Elm Street',
        service_city: 'Paterson',
        service_state: 'NJ',
        service_postal_code: '07501',
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha Home Services',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/api/ai-farm/spider/dispatch-alert')
      .set(authHeader('admin'))
      .send({
        leadId: mockLeadId,
        stageLabel: 'New',
        elapsedValue: 1,
        elapsedUnit: 'Day',
        assignments: {
          adminRoles: ['ADMIN'],
        },
        notifications: {
          email: true,
          sms: false,
        },
        testEmail: 'attaorakzai786@gmail.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.emailsSent).toBe(1);

    const emailCalls = (sendAutomationEmail as any).mock.calls;
    const testCall = emailCalls.find((c: any) => c[0].to === 'attaorakzai786@gmail.com');
    expect(testCall).toBeTruthy();
    expect(testCall[0].to).toBe('attaorakzai786@gmail.com');
    expect(testCall[0].subject).toContain('[Spider AI Alert] LD-107 (David Miller) is overdue in New');
  });
});
