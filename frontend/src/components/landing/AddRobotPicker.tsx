import React, { useState } from "react";
import { Plus, Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface AddRobotPickerProps {
  hiddenNames: string[];
  onAddExisting: (name: string) => void;
  onCreateNew: (name: string) => Promise<boolean>;
  isLoading: boolean;
}

const AddRobotPicker: React.FC<AddRobotPickerProps> = ({
  hiddenNames,
  onAddExisting,
  onCreateNew,
  isLoading,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const matchesExisting = hiddenNames.some(
    (n) => n.toLowerCase() === trimmed.toLowerCase()
  );
  const canCreate = trimmed.length > 0 && !matchesExisting;

  const reset = () => {
    setQuery("");
    setOpen(false);
  };

  const handlePickExisting = (name: string) => {
    onAddExisting(name);
    reset();
  };

  const handleCreate = async () => {
    if (!trimmed) return;
    const ok = await onCreateNew(trimmed);
    if (ok) reset();
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-end">
      <div className="space-y-2">
        <Label className="text-sm font-medium text-gray-300">Robot</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={isLoading}
              className="w-full justify-between bg-gray-800 border-gray-700 text-white hover:bg-gray-700 hover:text-white font-normal"
            >
              <span className="truncate text-gray-400">
                {isLoading
                  ? "Loading..."
                  : "Select an existing robot or type a new name"}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 bg-gray-800 border-gray-700 text-white"
            style={{ width: "var(--radix-popover-trigger-width)" }}
            align="start"
          >
            <Command className="bg-gray-800">
              <CommandInput
                placeholder="Search or type new name..."
                value={query}
                onValueChange={setQuery}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
                className="text-white"
              />
              <CommandList>
                {hiddenNames.length === 0 && !canCreate && (
                  <CommandEmpty className="py-4 text-sm text-gray-400 text-center">
                    No hidden robots. Type a name to create one.
                  </CommandEmpty>
                )}
                {hiddenNames.length > 0 && (
                  <CommandGroup heading="Existing">
                    {hiddenNames.map((name) => (
                      <CommandItem
                        key={name}
                        value={name}
                        onSelect={() => handlePickExisting(name)}
                        className="text-white aria-selected:bg-gray-700"
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            matchesExisting &&
                              name.toLowerCase() === trimmed.toLowerCase()
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        {name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {canCreate && (
                  <CommandGroup heading={hiddenNames.length > 0 ? "New" : undefined}>
                    <CommandItem
                      value={`__create__${trimmed}`}
                      onSelect={handleCreate}
                      className="text-white aria-selected:bg-gray-700"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create &quot;{trimmed}&quot;
                    </CommandItem>
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <Button
        onClick={() => {
          if (canCreate) {
            handleCreate();
          } else if (matchesExisting) {
            handlePickExisting(
              hiddenNames.find(
                (n) => n.toLowerCase() === trimmed.toLowerCase()
              )!
            );
          }
        }}
        disabled={!canCreate && !matchesExisting}
        className="bg-blue-500 hover:bg-blue-600 text-white"
      >
        <Plus className="w-4 h-4 mr-2" />
        Add Robot
      </Button>
    </div>
  );
};

export default AddRobotPicker;
