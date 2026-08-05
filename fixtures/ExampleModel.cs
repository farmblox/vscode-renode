//
// FIXTURE — a generic Renode C# model, present so member resolution is pinned by the
// LANGUAGE rather than by whatever models a surrounding project happens to ship. It covers
// the three ways a platform description or script names something a model defines:
//
//   * a public property          -> `frequency:` in a .repl
//   * a constructor parameter    -> `label:` in a .repl (attributes bind to these too)
//   * a public GPIO output       -> `Alarm -> nvic@3` wiring
//   * a public method            -> `example Poke 1` in a .resc
//   * an Emulation extension     -> `emulation CreateExampleThing "thing"`
//
// Not compiled or loaded by anything; it exists to be parsed.
//
using Antmicro.Renode.Core;
using Antmicro.Renode.Peripherals;

namespace Antmicro.Renode.Fixtures
{
    public static class ExampleModelExtensions
    {
        /// <summary>
        /// Creates an ExampleModel and registers it on the emulation under <paramref name="name"/>.
        /// </summary>
        public static void CreateExampleThing(this Emulation emulation, string name)
        {
            emulation.ExternalsManager.AddExternal(new ExampleModel(0), name);
        }
    }

    public class ExampleModel : IPeripheral
    {
        // A constructor parameter. A .repl attribute binds to one of these just as readily
        // as to a property, which is why both are searched.
        public ExampleModel(int slot,
                            // A comment inside the parameter list, which a naive paren
                            // scanner would choke on.
                            string label = "unnamed")
        {
            this.slot = slot;
            this.label = label;
        }

        /// <summary>Kernel clock driving this peripheral, in hertz.</summary>
        public ulong Frequency { get; set; }

        /// <summary>Raised when the configured threshold is crossed.</summary>
        public GPIO Alarm { get; private set; }

        /// <summary>Nudge the model, for a test that needs it to act out of band.</summary>
        public void Poke(int times)
        {
        }

        public void Reset()
        {
        }

        private readonly int slot;
        private readonly string label;
    }
}
