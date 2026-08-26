/**
 * The convert-to-job dialog, as the ROUTED lead page mounts it.
 *
 * These cases were written against `components/leads/CreateJobFromLeadDialog`, whose only
 * caller was the unrouted `pages/LeadDetailPage`. That page is gone and so is the component;
 * the selection rules it encoded live on in `../components/createJobFromLeadDialog`, which had
 * no test of its own. The cases are unchanged - the v2 dialog seeds its selection from a lazy
 * initialiser on a body that only exists while the dialog is open, rather than from an effect
 * keyed on `open`, and the rule ("a valid preselect wins, else a lone convertible estimate,
 * else nothing") is the same rule.
 */
import { vi, test, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateJobFromLeadDialog } from '../components/createJobFromLeadDialog';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const base = {
  open: true,
  onOpenChange: vi.fn(),
  leadId: 'lead-1',
  canCreateEstimate: true,
  isConverting: false,
  onConvert: vi.fn(),
};

const approved = {
  id: 'e1',
  estimate_number: 'E00001',
  status: 'WON',
  total_amount: '1000',
  created_at: '2026-01-01',
  job: null,
};
const approved2 = {
  id: 'e4',
  estimate_number: 'E00004',
  status: 'WON',
  total_amount: '1200',
  created_at: '2026-01-04',
  job: null,
};
const sent = {
  id: 'e2',
  estimate_number: 'E00002',
  status: 'SENT',
  total_amount: '500',
  created_at: '2026-01-02',
  job: null,
};
const converted = {
  id: 'e3',
  estimate_number: 'E00003',
  status: 'WON',
  total_amount: '900',
  created_at: '2026-01-03',
  job: { id: 'job-7', job_number: 'J00007', status: 'UNSCHEDULED' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// Case 1: no estimates → empty state message + Create job disabled
test('renders "No estimates yet" and Create job is disabled when estimates is empty', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[]} />);
  expect(screen.getByText(/no estimates yet/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 2: single approved estimate auto-selected; Create job enabled; clicking calls onConvert
test('auto-selects the sole approved estimate and calls onConvert on click', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[approved]} />);
  const btn = screen.getByRole('button', { name: /create job/i });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(base.onConvert).toHaveBeenCalledWith('e1');
});

// Case 3: only SENT estimate → no approved message; Create job disabled
test('shows "No approved estimate to convert yet" and Create job is disabled for SENT-only', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[sent]} />);
  expect(screen.getByText(/no approved estimate to convert yet/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 4: already-converted estimate shows job_number link; clicking it calls navigate + closes dialog
test('shows J00007 link and clicking it navigates to the job and closes dialog', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[converted]} />);
  const link = screen.getByRole('button', { name: /J00007/i });
  expect(link).toBeInTheDocument();
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith('/jobs/job-7');
  expect(base.onOpenChange).toHaveBeenCalledWith(false);
  // No convertible → Create job disabled
  expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
});

// Case 5: preselectEstimateId picks the right estimate among multiple convertibles
test('preselectEstimateId selects the right estimate when multiple convertibles present', () => {
  render(
    <CreateJobFromLeadDialog
      {...base}
      estimates={[approved2, approved]}
      preselectEstimateId="e1"
    />
  );
  const btn = screen.getByRole('button', { name: /create job/i });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(base.onConvert).toHaveBeenCalledWith('e1');
});

// Case 6: canCreateEstimate=true → New estimate present; clicking it navigates + closes dialog
test('New estimate button navigates and closes dialog', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[]} canCreateEstimate={true} />);
  const newEstBtn = screen.getByRole('button', { name: /new estimate/i });
  expect(newEstBtn).toBeInTheDocument();
  fireEvent.click(newEstBtn);
  expect(navigate).toHaveBeenCalledWith('/estimates/new?lead_id=lead-1');
  expect(base.onOpenChange).toHaveBeenCalledWith(false);
});

// Case 7: canCreateEstimate=false → no "New estimate" control
test('no New estimate button when canCreateEstimate is false', () => {
  render(<CreateJobFromLeadDialog {...base} estimates={[]} canCreateEstimate={false} />);
  expect(screen.queryByRole('button', { name: /new estimate/i })).not.toBeInTheDocument();
});
