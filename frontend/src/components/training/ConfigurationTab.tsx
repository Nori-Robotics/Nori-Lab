import React from 'react';
import EssentialsCard from './config/EssentialsCard';
import AdvancedCard from './config/AdvancedCard';
import { ConfigComponentProps } from './types';

const ConfigurationTab: React.FC<ConfigComponentProps> = ({ config, updateConfig }) => {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <EssentialsCard config={config} updateConfig={updateConfig} />
      <AdvancedCard config={config} updateConfig={updateConfig} />
    </div>
  );
};

export default ConfigurationTab;
