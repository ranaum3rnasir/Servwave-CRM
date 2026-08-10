import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AI_AGENT_COUNT } from '@/lib/ai-center/agents';
import { AiCenterModal } from './AiCenterModal';

function setDemoOrg(isDemo: boolean) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({ user: { id: 'u1', role: 'ADMIN', org_is_demo: isDemo }, isAuthenticated: true }),
  );
}

beforeEach(() => {
  // Simulate an explicit request to open the AI Agentic Farm (e.g. a stray entry point).
  useAiCenterStore.setState({ open: true, focusAgentId: null });
});

describe('AiCenterModal — available to all orgs', () => {
  it('renders the dialog for a real (non-demo) org', () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the dialog for a demo org', () => {
    setDemoOrg(true);
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // None of the 30 agents is built - the catalog is discovery plus "book a
  // call". The status label and the header must say so rather than claim a
  // live, working team.
  it('does not present unbuilt agents as live', () => {
    setDemoOrg(false);
    renderWithProviders(<AiCenterModal />);
    expect(screen.queryAllByText('Available')).toHaveLength(0);
    expect(screen.getAllByText('Coming soon')).toHaveLength(AI_AGENT_COUNT);
    // The phrase, not a bare 24/7: Falcon's own card legitimately says "works
    // 24/7" and renders in this same modal.
    expect(screen.queryByText(/agents working 24\/7/i)).toBeNull();
  });

  it('the agent detail modal carries the same roadmap label', () => {
    setDemoOrg(false);
    useAiCenterStore.setState({ focusAgentId: 'mike' });
    renderWithProviders(<AiCenterModal />);
    expect(screen.getByText('Book a call about Border Collie')).toBeInTheDocument();
    expect(screen.queryAllByText('Available')).toHaveLength(0);
  });
});
