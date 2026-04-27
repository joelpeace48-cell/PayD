import React from 'react';
import { useNetworkStore, type StellarNetwork } from '../stores/networkStore';

export const NetworkSwitcher: React.FC = () => {
  const { network, setNetwork } = useNetworkStore();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setNetwork(e.target.value as StellarNetwork);
  };

  const isTestnet = network === 'TESTNET';

  return (
    <div role="group" aria-label="Stellar network selector">
      <select
        value={network}
        onChange={handleChange}
        aria-label="Select Stellar network"
        title="Switch Stellar network"
        className={[
          'text-[10px] font-mono font-bold uppercase tracking-widest',
          'px-2 py-1 rounded border bg-surface border-hi text-text cursor-pointer',
          'focus:outline-none transition-colors appearance-none',
          isTestnet
            ? 'border-yellow-500/50 text-yellow-500 hover:border-yellow-400'
            : 'border-accent/50 text-accent hover:border-accent',
        ].join(' ')}
      >
        <option value="TESTNET" className="bg-surface text-text">
          Testnet
        </option>
        <option value="MAINNET" className="bg-surface text-text">
          Mainnet
        </option>
      </select>
    </div>
  );
};
