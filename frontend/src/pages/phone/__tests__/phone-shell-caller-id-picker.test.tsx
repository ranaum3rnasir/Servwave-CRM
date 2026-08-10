// Master plan Task B3 — the /phone tab's caller-ID picker: an optional
// per-call override, allow-list only (the user's own assigned numbers +
// the org default from Task B3's GET /api/communication/my-numbers — never
// free text, never another user's number). Default selection is the
// resolved primary number from Task B1/B2 (useMyOutboundNumber). Selecting
// a different allow-listed number changes what rides as dialFrom
// (officeSoftphone.call(e164, fromTpnId)) on the NEXT call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/__tests__/helpers";
import { PHONE_TAB_NAME } from "@/lib/communication/phoneTabHandoff";

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
  isPending: false,
}));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(555) 555-0208",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
  // PhoneShell now hosts the full DialerWorkspace (search + softphone + panel),
  // so these are pulled in too. The picker test never searches, so an empty
  // search + empty call list keep the panel on its idle state.
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
}));

type FakeDevice = {
  call: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  ready: boolean;
};
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

// Task B1/B2's resolved-default hook — the picker's default selection.
type Resolved =
  | { ctm_number_id: string; phone_number_id: string; formatted: string | null }
  | { none: true };
const myOutboundNumber = vi.hoisted(() => ({ current: null as null | Resolved }));

vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: vi.fn((enabled: boolean) => ({
    data: enabled ? myOutboundNumber.current : undefined,
  })),
}));

// Task B3's allow-list hook — the picker's option list. `phoneNumbers.ts`
// also exports admin-only assignment hooks (untouched here) — only
// `useMyNumbers` is mocked, so a picker that reached for the admin hook
// instead would fail loudly rather than silently pass.
type MyNumbers = { numbers: Array<{
  phone_number_id: string;
  ctm_number_id: string;
  formatted: string | null;
  is_org_default: boolean;
  is_user_default: boolean;
}> };
const myNumbers = vi.hoisted(() => ({ current: { numbers: [] } as MyNumbers }));

vi.mock("@/lib/api/phoneNumbers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/phoneNumbers")>(
    "@/lib/api/phoneNumbers",
  );
  return {
    ...actual,
    useMyNumbers: vi.fn(() => ({ data: myNumbers.current })),
  };
});

import { PhoneShell } from "../PhoneShell";
import { useMyNumbers } from "@/lib/api/phoneNumbers";

const TPN_USER = "TPN_USER_DEFAULT";
const TPN_ORG = "TPN_ORG_DEFAULT";
const TPN_EXTRA = "TPN_EXTRA_ASSIGNED";

const USER_DEFAULT_OPTION = {
  phone_number_id: "pn_user",
  ctm_number_id: TPN_USER,
  formatted: "(609) 555-0100",
  is_org_default: false,
  is_user_default: true,
};
const ORG_DEFAULT_OPTION = {
  phone_number_id: "pn_org",
  ctm_number_id: TPN_ORG,
  formatted: "(555) 555-0208",
  is_org_default: true,
  is_user_default: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true };
  myOutboundNumber.current = {
    ctm_number_id: TPN_USER,
    phone_number_id: "pn_user",
    formatted: "(609) 555-0100",
  };
  myNumbers.current = { numbers: [USER_DEFAULT_OPTION, ORG_DEFAULT_OPTION] };
});

async function placeACall() {
  const input = screen.getByPlaceholderText("Enter a number");
  await userEvent.type(input, "5555550212");
  await userEvent.click(screen.getByRole("button", { name: "Call" }));
}

describe("/phone caller-ID picker (Task B3)", () => {
  it("lists ONLY the allow-listed numbers (assigned + org default) — a closed list, never free text", () => {
    renderWithProviders(<PhoneShell />);

    const picker = screen.getByRole("combobox", { name: /caller id|calling from/i });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(screen.getByRole("option", { name: /\(609\) 555-0100/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\(555\) 555-0208/ })).toBeInTheDocument();

    // Never a free-text entry for caller ID: it's a SELECT. The two textboxes
    // present are the workspace's job/customer search and the dial-pad number
    // field — neither is the caller-ID, which stays a closed picker.
    expect(picker.tagName).toBe("SELECT");
    expect(screen.getByPlaceholderText("Enter a number")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search a job #/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /caller id|calling from/i })).not.toBeInTheDocument();
  });

  it("defaults the selection to the resolved primary number (Task B1/B2)", () => {
    renderWithProviders(<PhoneShell />);

    const picker = screen.getByRole("combobox", { name: /caller id|calling from/i }) as HTMLSelectElement;
    expect(picker.value).toBe(TPN_USER);
  });

  it("passes the resolved default as dialFrom when the user places a call without switching", async () => {
    renderWithProviders(<PhoneShell />);

    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550212", TPN_USER),
    );
  });

  it("switching the picker changes what is passed as dialFrom on the NEXT call", async () => {
    renderWithProviders(<PhoneShell />);

    const picker = screen.getByRole("combobox", { name: /caller id|calling from/i });
    await userEvent.selectOptions(picker, TPN_ORG);

    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550212", TPN_ORG),
    );
    expect(softphone.current!.call).not.toHaveBeenCalledWith("+15555550212", TPN_USER);
  });

  it("a user with more than one number can pick a THIRD assigned number too (not just user-default/org-default)", async () => {
    myNumbers.current = {
      numbers: [
        ...myNumbers.current.numbers,
        {
          phone_number_id: "pn_extra",
          ctm_number_id: TPN_EXTRA,
          formatted: "(212) 555-0199",
          is_org_default: false,
          is_user_default: false,
        },
      ],
    };
    renderWithProviders(<PhoneShell />);

    const picker = screen.getByRole("combobox", { name: /caller id|calling from/i });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.selectOptions(picker, TPN_EXTRA);

    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550212", TPN_EXTRA),
    );
  });

  it("a user with exactly ONE allow-listed number sees it read-only/default — no interactive picker", () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION] };

    renderWithProviders(<PhoneShell />);

    expect(screen.queryByRole("combobox", { name: /caller id|calling from/i })).not.toBeInTheDocument();
    // The single number is still shown, just not as a picker.
    expect(screen.getByText(/\(609\) 555-0100/)).toBeInTheDocument();
  });

  it("a user with exactly one number still dials from it (no picker needed to resolve dialFrom)", async () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION] };

    renderWithProviders(<PhoneShell />);
    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550212", TPN_USER),
    );
  });
});

// Sanity: the mocked hook is actually what the module under test imports —
// guards against a stale mock path silently no-op'ing (e.g. the picker
// reading a hook from a different module and this test passing for the
// wrong reason).
describe("useMyNumbers mock wiring sanity", () => {
  it("is the mocked fn PhoneShell/Softphone would call", () => {
    expect(vi.isMockFunction(useMyNumbers)).toBe(true);
  });
});

// A tab's `window.name` sticks across in-tab navigation (HTML spec), so once
// this tab is left via any route change, it must stop impersonating the
// PHONE_TAB_NAME handoff target — otherwise the next Call button clicked FROM
// this same tab would find `window.open(url, 'servwave-phone')` targeting its
// OWN name, which the spec resolves as an in-place navigation, not a new tab.
describe("browsing-context name cleanup on unmount", () => {
  afterEach(() => {
    window.name = "";
  });

  it("resets window.name when this tab was the PHONE_TAB_NAME target", () => {
    window.name = PHONE_TAB_NAME;
    const { unmount } = renderWithProviders(<PhoneShell />);

    unmount();

    expect(window.name).toBe("");
  });

  it("leaves an unrelated window.name untouched", () => {
    window.name = "some-other-window";
    const { unmount } = renderWithProviders(<PhoneShell />);

    unmount();

    expect(window.name).toBe("some-other-window");
  });
});
