import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";

test("arrow keys, Enter and type-ahead pick an option", () => {
  const onChange = jest.fn();
  render(
    <Select label="Make" value="" onChange={onChange}>
      <option value="">All makes</option>
      <option value="audi">Audi</option>
      <option value="bmw">BMW</option>
    </Select>
  );
  screen.getByRole("button", { name: "Make All makes" });
  const list = screen.getByRole("listbox", { hidden: true });
  fireEvent.keyDown(list, { key: "ArrowDown" });
  fireEvent.keyDown(list, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith("audi");
  fireEvent.keyDown(list, { key: "b" });
  fireEvent.keyDown(list, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith("bmw");
});
