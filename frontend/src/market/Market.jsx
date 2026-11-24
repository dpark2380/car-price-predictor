import "./market.css";
import { BrandIndex, BrandView } from "./BrandView";
import CarView from "./CarView";
import MethodView from "./MethodView";
import ModelView from "./ModelView";
import { NavContext } from "./parts";

// The Market area: /market, /market/<make>, /market/<make>/<model>, /market/method, /car/<vin>.
// The shell (header, footer, URL handling) lives in the dashboard; this renders what goes inside <main>.
export default function Market({ path, navigate }) {
  let parts;
  try {
    parts = path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    parts = [];
  }
  let page;
  if (parts[0] === "car" && parts[1]) page = <CarView key={path} vin={parts[1]} />;
  else if (parts[0] === "market" && parts.length === 2 && parts[1] === "method") page = <MethodView key={path} />;
  else if (parts[0] === "market" && parts.length === 2) page = <BrandView key={path} make={parts[1]} />;
  else if (parts[0] === "market" && parts.length > 2) page = <ModelView key={path} make={parts[1]} model={parts.slice(2).join("/")} />;
  else page = <BrandIndex key={path} />;
  return (
    <NavContext.Provider value={navigate}>
      <div className="market">{page}</div>
    </NavContext.Provider>
  );
}
