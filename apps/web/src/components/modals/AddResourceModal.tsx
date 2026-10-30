import React, { useEffect, useState } from 'react';
import { X, Plus, FolderPlus, Cpu, Layers, Building2, Factory, Trash2 } from 'lucide-react';

export interface AddResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  parentPath?: string;
  allowedTypes?: string[];
  onAddResource?: (newResource: {
    name: string;
    type: string;
    parentPath: string;
    description: string;
    properties: Record<string, string>;
  }) => void;
}

export const AddResourceModal: React.FC<AddResourceModalProps> = ({
  isOpen,
  onClose,
  parentPath = '(root)',
  allowedTypes = ['Enterprise', 'Site', 'Plant', 'Zone', 'Line', 'Workshop', 'Machine', 'Sensor'],
  onAddResource,
}) => {
  const [name, setName] = useState('');
  const [type, setType] = useState(allowedTypes[0] || 'Machine');
  const [currentPath, setCurrentPath] = useState(parentPath);
  const [description, setDescription] = useState('');
  const [properties, setProperties] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState('');
  const allowedKey = allowedTypes.join('|');

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setType(allowedTypes[0] || 'Machine');
    setCurrentPath(parentPath);
    setDescription('');
    setProperties([]);
    setError('');
  }, [isOpen, parentPath, allowedKey]);

  if (!isOpen) return null;

  const handleAddProperty = () => {
    setProperties([...properties, { key: '', value: '' }]);
  };

  const handleRemoveProperty = (index: number) => {
    setProperties(properties.filter((_, i) => i !== index));
  };

  const handlePropertyChange = (index: number, field: 'key' | 'value', val: string) => {
    const next = [...properties];
    next[index][field] = val;
    setProperties(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const chosen = allowedTypes.includes(type) ? type : allowedTypes[0];
    if (!chosen) return;

    const propsMap = properties.reduce<Record<string, string>>((acc, item) => {
      if (item.key.trim()) acc[item.key.trim()] = item.value.trim();
      return acc;
    }, {});

    try {
      await onAddResource?.({
        name: name.trim(),
        type: chosen,
        parentPath: currentPath,
        description: description.trim(),
        properties: propsMap,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The server rejected this resource.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center font-bold">
              <FolderPlus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Add Factory Resource</h2>
              <p className="text-xs text-slate-500">Define and insert a new entity into the factory hierarchy</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto flex-1 text-sm">
          {/* Context Path */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
              Context Path (Parent)
            </label>
            <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700 break-all">
              {currentPath}
            </div>
          </div>

          {/* Resource Name and Type */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Resource Name <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CNC-03, Line 04, Packaging Line"
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Resource Type <span className="text-[#EF1B24]">*</span>
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              >
                {allowedTypes.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Description
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Operational purpose, physical location, or maintenance notes..."
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
            />
          </div>

          {/* Key-Value Properties */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-700">
                Resource Metadata & Technical Attributes
              </label>
              <button
                type="button"
                onClick={handleAddProperty}
                className="text-xs font-medium text-[#EF1B24] hover:text-red-700 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add Property
              </button>
            </div>
            <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
              {properties.map((prop, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Key (e.g. SerialNum)"
                    value={prop.key}
                    onChange={(e) => handlePropertyChange(idx, 'key', e.target.value)}
                    className="flex-1 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-800 focus:outline-none focus:border-[#EF1B24]"
                  />
                  <input
                    type="text"
                    placeholder="Value"
                    value={prop.value}
                    onChange={(e) => handlePropertyChange(idx, 'value', e.target.value)}
                    className="flex-1 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-800 focus:outline-none focus:border-[#EF1B24]"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveProperty(idx)}
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}

          {/* Footer Actions */}
          <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 text-xs font-semibold text-white bg-[#EF1B24] hover:bg-[#d0171f] rounded-lg shadow-sm transition-all flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> Create Resource
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
