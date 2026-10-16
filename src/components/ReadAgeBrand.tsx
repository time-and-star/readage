import React from 'react';

const readAgeLogoUrl = new URL('../../assets/brand/readge-icon-256.png', import.meta.url).href;

type ReadAgeLogoProps = {
  className?: string;
};

type ReadAgeBrandProps = {
  className?: string;
  logoClassName?: string;
  nameClassName?: string;
  textTone?: 'default' | 'inverse';
};

export function ReadAgeLogo({ className = 'h-8 w-8' }: ReadAgeLogoProps) {
  return (
    <img
      src={readAgeLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`shrink-0 object-contain ${className}`}
    />
  );
}

export function ReadAgeBrand({
  className = '',
  logoClassName = 'h-8 w-8',
  nameClassName = '',
  textTone = 'default',
}: ReadAgeBrandProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <ReadAgeLogo className={logoClassName} />
      <span
        className={`font-display text-lg font-semibold tracking-[-0.035em] ${
          textTone === 'inverse' ? 'text-[#F1EADB]' : 'text-[#2B2723]'
        } ${nameClassName}`}
      >
        ReadAge
      </span>
    </span>
  );
}
