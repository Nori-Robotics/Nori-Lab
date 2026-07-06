
import React from 'react';
import { cn } from '@/lib/utils';

interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  iconOnly?: boolean;
}

const Logo: React.FC<LogoProps> = ({
  className,
  iconOnly = false
}) => {
  return <div className={cn("flex items-center gap-2", className)}>
      <img src="/nori-logo.png" alt="Nori Logo" className="h-8 w-8" />
      {!iconOnly && <span className="font-bold text-foreground text-2xl">LeLab</span>}
    </div>;
};

export default Logo;
