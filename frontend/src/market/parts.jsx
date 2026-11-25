import { Fragment, createContext, useContext } from "react";

// The shell supplies navigate(path); links stay real hrefs so middle-click and copy work.
export const NavContext = createContext((path) => { window.location.assign(path); });

export function Link({ to, children, className, ...rest }) {
  const navigate = useContext(NavContext);
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export const Src = ({ children }) => <span className="src">{children}</span>;

export function Crumbs({ items }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && " / "}
          {c.to ? <Link to={c.to}>{c.text}</Link> : <span aria-current="page">{c.text}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

// [{k, v, s, cls}] as the mockup's four-up summary.
export function KeyFacts({ items, three }) {
  return (
    <dl className={`keyfacts${three ? " three" : ""}`}>
      {items.filter(Boolean).map((it) => (
        <div key={it.k}>
          <dt>{it.k}</dt>
          <dd className={`num${it.cls ? ` ${it.cls}` : ""}`}>{it.v}</dd>
          {it.s != null && <dd className="s">{it.s}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function Fig({ title, src, children, as: Title = "h3" }) {
  return (
    <div className="panel fig">
      <div className="fig-head"><Title>{title}</Title>{src && <Src>{src}</Src>}</div>
      {children}
    </div>
  );
}

export function Section({ id, title, src, children, first }) {
  return (
    <section className={`section${first ? " first" : ""}`} aria-labelledby={id}>
      <div className="section-head"><h2 id={id}>{title}</h2>{src && <Src>{src}</Src>}</div>
      {children}
    </section>
  );
}

export function Skeleton({ label = "Loading" }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div className="skeleton" style={{ height: 36, width: "50%", maxWidth: 360 }} />
      <div className="panel section first"><div className="skeleton" style={{ height: 14, width: "60%" }} /><div className="skeleton" style={{ height: 70, marginTop: 14 }} /></div>
      <div className="panel section"><div className="skeleton" style={{ height: 14, width: "40%" }} /><div className="skeleton" style={{ height: 220, marginTop: 14 }} /></div>
    </div>
  );
}

export function ErrorBox({ error, onRetry, notFound, back }) {
  if (error?.status === 404 || notFound) {
    return (
      <div className="empty" style={{ marginTop: 20 }}>
        <p>{notFound || "We have no data for this page."}</p>
        {back && <p style={{ marginTop: 8 }}><Link className="btn-link" to={back.to}>{back.text}</Link></p>}
      </div>
    );
  }
  return (
    <div className="alert" role="alert" style={{ marginTop: 20 }}>
      <p>{error?.status ? "The server couldn't load this page." : "Couldn't reach the server."} Check your connection and try again.</p>
      <p style={{ marginTop: 10 }}><button type="button" className="btn-quiet" onClick={onRetry}>Try again</button></p>
    </div>
  );
}
