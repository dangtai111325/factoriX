import React, { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { House, Box, Database, Activity, Monitor, ChevronDown, RotateCcw } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../features/auth';
import { ConfirmDialog } from '../common/ConfirmDialog';

interface NavChild {
  label: string;
  path: string;
}

interface NavGroup {
  id: string;
  label: string;
  icon: React.ElementType;
  path?: string;
  children?: NavChild[];
}

const navConfig: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: House,
    path: '/overview',
  },
  {
    id: 'factory',
    label: 'Factory Model',
    icon: Box,
    children: [
      { label: 'Structure', path: '/factory/structure' },
      { label: 'Layout', path: '/factory/layout' },
      { label: 'Knowledge Graph', path: '/factory/graph' },
    ],
  },
  {
    id: 'acquisition',
    label: 'Acquisition',
    icon: Database,
    children: [
      { label: 'Connections', path: '/acquisition/connections' },
      { label: 'Edges', path: '/acquisition/edges' },
      { label: 'Add Data', path: '/acquisition/add-data' },
    ],
  },
  {
    id: 'signals',
    label: 'Signals',
    icon: Activity,
    children: [
      { label: 'Catalog', path: '/signals' },
      { label: 'Output Groups', path: '/signals/output-groups' },
    ],
  },
  {
    id: 'live',
    label: 'Live Operations',
    icon: Monitor,
    children: [
      { label: 'Monitor', path: '/live/monitor' },
      { label: 'Diagnostics', path: '/live/diagnostics' },
      { label: 'Activity Log', path: '/live/activity' },
    ],
  },
];

type SidebarProps = {
  open?: boolean;
  onClose?: () => void;
};

export const Sidebar: React.FC<SidebarProps> = ({ open = false, onClose }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { revertToZero } = useApp();
  const { signOut } = useAuth();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    factory: true,
    acquisition: true,
    signals: true,
    live: true,
  });
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState('');
  const [revertPassword, setRevertPassword] = useState('');
  const [revertError, setRevertError] = useState('');
  const [revertLoading, setRevertLoading] = useState(false);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isGroupActive = (group: NavGroup): boolean => {
    if (group.path && location.pathname === group.path) return true;
    if (group.children) {
      return group.children.some((c) => location.pathname.startsWith(c.path));
    }
    return false;
  };

  const runRevert = async () => {
    setRevertError('');
    if (revertConfirm !== 'REVERT') {
      setRevertError('Type REVERT to confirm.');
      return;
    }
    if (!revertPassword.trim()) {
      setRevertError('Enter your password.');
      return;
    }
    setRevertLoading(true);
    try {
      await revertToZero('REVERT', revertPassword);
      window.location.assign('/register');
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : 'Revert failed');
    } finally {
      setRevertLoading(false);
    }
  };

  const closeMobile = () => onClose?.();

  return (
    <>
      {open && (
        <button
          type="button"
          className="fx-sidebar-backdrop md:hidden"
          aria-label="Close navigation"
          onClick={closeMobile}
        />
      )}
      <aside className={`fx-sidebar select-none ${open ? 'fx-sidebar-open' : ''}`}>
        <div className="h-[62px] px-5 flex items-center justify-between border-b border-[#E3EAF3]">
          <div className="flex items-center gap-3">
            <img src="/factorix-logo.png" alt="FactoriX" className="h-7 w-auto object-contain" />
            <div className="flex flex-col fx-brand-text">
              <span className="text-[15px] font-bold tracking-tight text-[#111B37]">
                Factori<span className="text-[#EF1B24]">X</span>
              </span>
              <span className="text-[10px] uppercase font-semibold tracking-wider text-[#657794]">
                Industrial IoT
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navConfig.map((group) => {
            const Icon = group.icon;
            const active = isGroupActive(group);
            const hasChildren = group.children && group.children.length > 0;
            const isOpen = openGroups[group.id] ?? false;

            if (!hasChildren && group.path) {
              return (
                <NavLink
                  key={group.id}
                  to={group.path}
                  onClick={closeMobile}
                  title={group.label}
                  className={({ isActive }) =>
                    `fx-nav-item flex items-center gap-3.5 px-3 py-2.5 rounded-lg text-[14px] font-medium transition-all ${
                      isActive
                        ? 'bg-[#FFF0F1] text-[#EF1B24] font-semibold border-l-4 border-[#EF1B24]'
                        : 'text-[#334568] hover:bg-[#F9FAFD] hover:text-[#111B37]'
                    }`
                  }
                >
                  <Icon className={`w-5 h-5 ${active ? 'text-[#EF1B24]' : 'text-[#657794]'}`} />
                  <span className="fx-nav-label">{group.label}</span>
                </NavLink>
              );
            }

            return (
              <div key={group.id} className="space-y-0.5">
                <button
                  type="button"
                  title={group.label}
                  onClick={() => {
                    const compact =
                      typeof window !== 'undefined' &&
                      window.matchMedia('(max-width: 1279px) and (min-width: 768px)').matches;
                    if (compact && group.children?.[0]) {
                      navigate(group.children[0].path);
                      closeMobile();
                      return;
                    }
                    toggleGroup(group.id);
                  }}
                  className={`fx-nav-item w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-[14px] font-medium transition-colors ${
                    active
                      ? 'text-[#EF1B24] font-semibold bg-[#FFF0F1]/60'
                      : 'text-[#334568] hover:bg-[#F9FAFD]'
                  }`}
                >
                  <div className="flex items-center gap-3.5">
                    <Icon className={`w-5 h-5 ${active ? 'text-[#EF1B24]' : 'text-[#657794]'}`} />
                    <span className="fx-nav-label">{group.label}</span>
                  </div>
                  <ChevronDown
                    className={`fx-nav-chevron w-4 h-4 text-[#94A3B8] transition-transform duration-200 ${
                      isOpen ? 'rotate-180 text-[#EF1B24]' : ''
                    }`}
                  />
                </button>

                {isOpen && group.children && (
                  <div className="fx-nav-children ml-5 pl-3 border-l border-[#E2E8F0] space-y-0.5 py-1">
                    {group.children.map((child) => (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        onClick={closeMobile}
                        className={({ isActive }) =>
                          `flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                            isActive
                              ? 'text-[#EF1B24] font-bold bg-[#FFF0F1]'
                              : 'text-[#657794] hover:text-[#111B37] hover:bg-[#F9FAFD]'
                          }`
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                isActive ? 'bg-[#EF1B24]' : 'bg-transparent border border-[#CBD5E1]'
                              }`}
                            />
                            <span className="fx-nav-label">{child.label}</span>
                          </>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="p-3 border-t border-[#E3EAF3] bg-[#F9FAFD]/60">
          <button
            type="button"
            onClick={() => {
              setRevertOpen(true);
              setRevertConfirm('');
              setRevertPassword('');
              setRevertError('');
            }}
            className="w-full mb-2 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-[12px] font-medium text-[#F2343B] border border-[#FAC6C9] hover:bg-white transition-colors"
            title="Deletes the installation, including the administrator."
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="fx-sidebar-footer-text">Revert To Zero</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void signOut().then(() => {
                window.location.assign('/login');
              });
            }}
            className="w-full text-[11px] text-[#657794] hover:text-[#111B37] fx-sidebar-footer-text"
          >
            Sign out
          </button>
        </div>
      </aside>

      <ConfirmDialog
        open={revertOpen}
        title="Revert to zero"
        danger
        loading={revertLoading}
        confirmLabel="Revert now"
        cancelLabel="Cancel"
        onCancel={() => setRevertOpen(false)}
        onConfirm={() => void runRevert()}
        confirmDisabled={revertConfirm !== 'REVERT' || !revertPassword.trim()}
      >
        <p className="text-[13px] text-[#657794] mb-3">
          This deletes every user, model, connection and sample on this appliance. Type REVERT and enter your
          password to continue.
        </p>
        <label className="block text-[12px] font-semibold text-[#334568]">
          Confirmation
          <input
            className="mt-1 w-full fx-input"
            value={revertConfirm}
            onChange={(e) => setRevertConfirm(e.target.value)}
            placeholder="Type REVERT"
            autoFocus
          />
        </label>
        <label className="block text-[12px] font-semibold text-[#334568] mt-3">
          Password
          <input
            type="password"
            className="mt-1 w-full fx-input"
            value={revertPassword}
            onChange={(e) => setRevertPassword(e.target.value)}
            placeholder="Your administrator password"
          />
        </label>
        {revertError && <p className="mt-2 text-[12px] text-[#F2343B]">{revertError}</p>}
      </ConfirmDialog>
    </>
  );
};
