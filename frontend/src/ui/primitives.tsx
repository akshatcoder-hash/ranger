export function Button({ children, kind = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'quiet' }) {
  return <button className={`button button-${kind} ${className}`} {...props}>{children}</button>
}

export function StatusPill({ children, tone = 'green' }: { children: React.ReactNode; tone?: 'green' | 'violet' | 'gray' | 'amber' }) {
  return <span className={`status-pill status-${tone}`}><span className="status-dot" />{children}</span>
}
